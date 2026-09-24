import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { activationRejection } from './activation';
import { createUpdateManager } from './manager';
import { releaseUpdateLock, updateSafety, useUpdateGuard } from './safety';
import type { BuildInfo } from './build';
const a = { version: '0.1.1', buildId: 'a' },
  b = { version: '0.1.1', buildId: 'b' };
const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  releaseUpdateLock();
});
function setup() {
  let clock = 1000,
    online = true,
    server = b,
    fail = false,
    reply = true,
    activate = true;
  class Worker extends EventTarget {
    state = 'installed';
    constructor(public info: BuildInfo) {
      super();
    }
    postMessage(data: { type: string }, ports: MessagePort[]) {
      if (data.type === 'SIMCARE_BUILD') ports[0]!.postMessage(this.info);
      else {
        ports[0]!.postMessage(reply ? { ok: true } : { ok: false, reason: 'other-clients' });
        if (reply && activate) {
          container.controller = this;
          registration.waiting = null;
          container.dispatchEvent(new Event('controllerchange'));
        }
      }
    }
  }
  const registration = Object.assign(new EventTarget(), {
    waiting: new Worker(b) as Worker | null,
    installing: null as Worker | null,
    update: vi.fn(async () => undefined),
  });
  const container = Object.assign(new EventTarget(), {
    controller: new Worker(a) as Worker | null,
    register: vi.fn(async () => registration),
  });
  const reload = vi.fn();
  const fetcher = vi.fn(async () => {
    if (fail) throw Error('offline');
    return new Response(JSON.stringify(server));
  });
  const manager = createUpdateManager({
    serviceWorker: container as unknown as ServiceWorkerContainer,
    fetcher,
    online: () => online,
    now: () => clock,
    reload,
    build: a,
    timeout: 50,
  });
  closers.push(manager.dispose);
  return {
    manager,
    registration,
    container,
    reload,
    fetcher,
    Worker,
    set: (value: {
      clock?: number;
      online?: boolean;
      server?: BuildInfo;
      fail?: boolean;
      reply?: boolean;
      activate?: boolean;
    }) => {
      clock = value.clock ?? clock;
      online = value.online ?? online;
      server = value.server ?? server;
      fail = value.fail ?? fail;
      reply = value.reply ?? reply;
      activate = value.activate ?? activate;
    },
  };
}
describe('更新检查与激活', () => {
  it('检测已等待的新版本、合并检查、自动节流而手动可重试', async () => {
    const x = setup();
    const first = x.manager.check();
    expect(x.manager.check(true)).toBe(first);
    await first;
    expect(x.container.register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    expect(x.manager.state.status).toBe('ready');
    expect(x.manager.state.candidate).toEqual(b);
    x.manager.dismiss();
    expect(x.manager.state.dismissed).toBe('b');
    await x.manager.check();
    expect(x.fetcher).toHaveBeenCalledTimes(1);
    await x.manager.check(true);
    expect(x.fetcher).toHaveBeenCalledTimes(2);
    x.set({ clock: 400000 });
    await x.manager.check();
    expect(x.fetcher).toHaveBeenCalledTimes(3);
  });
  it('首次安装不提示，服务器版本变化但未下载完只显示准备中', async () => {
    const x = setup();
    x.container.controller = null;
    x.set({ server: a });
    await x.manager.check();
    expect(x.manager.state.candidate).toBeNull();
    expect(x.manager.state.status).toBe('current');
    x.set({ server: b });
    await x.manager.check(true);
    expect(x.manager.state.status).toBe('preparing');
    expect(x.reload).not.toHaveBeenCalled();
  });
  it('部署失败或离线不误报最新版，恢复网络可重试', async () => {
    const x = setup();
    x.set({ online: false });
    await x.manager.check();
    expect(x.manager.state.status).toBe('offline');
    expect(x.fetcher).not.toHaveBeenCalled();
    x.set({ online: true, fail: true });
    await x.manager.check(true);
    expect(x.manager.state.status).toBe('error');
    x.set({ fail: false });
    await x.manager.check(true);
    expect(x.manager.state.status).toBe('ready');
  });
  it('用户同意且新版接管后只刷新一次；意外接管不刷新', async () => {
    const x = setup();
    await x.manager.check();
    x.container.dispatchEvent(new Event('controllerchange'));
    expect(x.reload).not.toHaveBeenCalled();
    const applying = x.manager.apply();
    expect(x.manager.apply()).toBe(applying);
    await applying;
    expect(x.reload).toHaveBeenCalledTimes(1);
    x.container.dispatchEvent(new Event('controllerchange'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(x.reload).toHaveBeenCalledTimes(1);
  });
  it('未保存输入阻止更新，取消修改后允许重试', async () => {
    const x = setup(),
      scope = effectScope(),
      dirty = ref(true);
    closers.push(() => scope.stop());
    scope.run(() => useUpdateGuard(() => dirty.value));
    await x.manager.check();
    await x.manager.apply();
    expect(x.manager.state.message).toContain('保存或取消');
    expect(x.reload).not.toHaveBeenCalled();
    dirty.value = false;
    await x.manager.apply();
    expect(x.reload).toHaveBeenCalledOnce();
  });
  it('其他窗口阻止激活，拒绝后解除锁并允许重试', async () => {
    const x = setup();
    x.set({ reply: false });
    await x.manager.check();
    await x.manager.apply();
    expect(x.manager.state.message).toContain('关闭其他');
    expect(updateSafety.locked).toBe(false);
    expect(x.reload).not.toHaveBeenCalled();
    x.set({ reply: true });
    await x.manager.apply();
    expect(x.reload).toHaveBeenCalledOnce();
  });
  it('激活超时最后检查实际控制器，未成功则保留旧版并解除锁', async () => {
    const x = setup();
    x.set({ activate: false });
    await x.manager.check();
    await x.manager.apply();
    expect(x.manager.state.message).toContain('超时');
    expect(updateSafety.locked).toBe(false);
    expect(x.reload).not.toHaveBeenCalled();
    x.set({ activate: true });
    await x.manager.apply();
    expect(x.reload).toHaveBeenCalledOnce();
  });
  it('同版本重建或版本回退按构建标识识别，不激活已过时的候选', async () => {
    const x = setup();
    x.set({ server: { version: '0.1.0', buildId: 'rollback' } });
    await x.manager.check();
    expect(x.manager.state.candidate).toBeNull();
    expect(x.manager.state.status).toBe('preparing');
    x.registration.waiting = new x.Worker({ version: '0.1.0', buildId: 'rollback' });
    await x.manager.check(true);
    expect(x.manager.state.candidate?.buildId).toBe('rollback');
  });
});
it('SW 激活校验请求来源、构建和同作用域窗口数量', () => {
  const source = { id: '1', url: 'https://app.test/#/settings' },
    other = { id: '2', url: 'https://app.test/#/health' };
  expect(activationRejection('b', 'b', 'https://app.test/', source, [source])).toBeNull();
  expect(activationRejection('b', 'b', 'https://app.test/', source, [source, other])).toBe(
    'other-clients',
  );
  expect(activationRejection('a', 'b', 'https://app.test/', source, [source])).toBe(
    'invalid-request',
  );
  expect(activationRejection('b', 'b', 'https://app.test/', null, [source])).toBe(
    'invalid-request',
  );
  expect(
    activationRejection('b', 'b', 'https://app.test/', { id: 'x', url: 'https://evil.test/' }, [
      source,
    ]),
  ).toBe('invalid-request');
});
