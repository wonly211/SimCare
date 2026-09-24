import { reactive } from 'vue';
import { currentBuild, isBuildInfo, type BuildInfo } from './build';
import { acquireUpdateLock, releaseUpdateLock } from './safety';
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'preparing'
  | 'ready'
  | 'offline'
  | 'error'
  | 'unsupported'
  | 'updating';
interface Environment {
  serviceWorker: ServiceWorkerContainer;
  fetcher?: typeof fetch;
  online?: () => boolean;
  now?: () => number;
  reload?: () => void;
  build?: BuildInfo;
  timeout?: number;
}
export function messageWorker(
  worker: ServiceWorker,
  data: unknown,
  timeout = 3000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('更新响应超时，请重试')), timeout);
    channel.port1.onmessage = (event) => finish(undefined, event.data);
    channel.port1.onmessageerror = () => finish(new Error('更新响应无效，请重试'));
    try {
      worker.postMessage(data, [channel.port2]);
    } catch (reason) {
      finish(reason instanceof Error ? reason : new Error('无法联系更新服务'));
    }
  });
}
export function createUpdateManager(env: Environment) {
  const build = env.build ?? currentBuild;
  const state = reactive({
    status: 'idle' as UpdateStatus,
    message: '',
    candidate: null as BuildInfo | null,
    dismissed: '',
    current: build,
  });
  const fetcher = env.fetcher ?? fetch;
  const online = env.online ?? (() => navigator.onLine);
  const now = env.now ?? Date.now;
  const reload = env.reload ?? (() => location.reload());
  let registration: ServiceWorkerRegistration | undefined;
  let startPromise: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  let applying: Promise<void> | undefined;
  let lastAuto = -Infinity;
  let expected: string | undefined;
  let reloaded = false;
  let disposed = false;
  let deployed: BuildInfo | undefined;
  const removers: Array<() => void> = [];
  const observed = new WeakSet<ServiceWorker>();
  const set = (status: UpdateStatus, message: string) => {
    if (!disposed) Object.assign(state, { status, message });
  };
  async function inspectWaiting() {
    const waiting = registration?.waiting;
    if (!waiting || !env.serviceWorker.controller) return;
    const info = await messageWorker(waiting, { type: 'SIMCARE_BUILD' });
    if (disposed || registration?.waiting !== waiting || !isBuildInfo(info)) return;
    if (info.buildId === build.buildId) return;
    if (deployed && info.buildId !== deployed.buildId) {
      state.candidate = null;
      set('preparing', '新版正在准备，请稍后再检查');
      return;
    }
    state.candidate = info;
    set('ready', '简护有新版本，可以更新了');
  }
  function observe(worker: ServiceWorker | null) {
    if (!worker || observed.has(worker)) return;
    observed.add(worker);
    const listener = () => {
      if (worker.state === 'installed')
        void inspectWaiting().catch(() => set('error', '新版检查失败，请重试'));
      if (worker.state === 'redundant' && !state.candidate && !expected)
        set('error', '新版下载未完成，请检查网络后重试');
    };
    worker.addEventListener('statechange', listener);
    removers.push(() => worker.removeEventListener('statechange', listener));
    listener();
  }
  async function confirmController(): Promise<boolean> {
    if (!expected || reloaded || !env.serviceWorker.controller) return reloaded;
    try {
      const info = await messageWorker(env.serviceWorker.controller, { type: 'SIMCARE_BUILD' });
      if (isBuildInfo(info) && info.buildId === expected && !reloaded && !disposed) {
        reloaded = true;
        reload();
        return true;
      }
    } catch {
      /* Activation may still be finishing; the timeout performs one final check. */
    }
    return false;
  }
  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      registration = await env.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      if (disposed) return;
      const found = () => {
        observe(registration?.installing ?? null);
      };
      const controlled = () => {
        void confirmController();
      };
      registration.addEventListener('updatefound', found);
      env.serviceWorker.addEventListener('controllerchange', controlled);
      removers.push(
        () => registration?.removeEventListener('updatefound', found),
        () => env.serviceWorker.removeEventListener('controllerchange', controlled),
      );
      found();
      await inspectWaiting().catch(() => undefined);
    })().catch((reason) => {
      startPromise = undefined;
      throw reason;
    });
    return startPromise;
  }
  function check(manual = false): Promise<void> {
    if (checking) return checking;
    if (applying) return applying;
    if (!online()) {
      set('offline', '当前离线，联网后可以检查更新');
      return Promise.resolve();
    }
    if (!manual && now() - lastAuto < 5 * 60_000) return Promise.resolve();
    lastAuto = now();
    set('checking', '正在检查更新…');
    const abort = new AbortController();
    const checkTimeout = setTimeout(() => abort.abort(), 15000);
    checking = (async () => {
      await start();
      const response = await fetcher('/version.json', {
        cache: 'no-store',
        signal: abort.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('无法获取部署版本');
      const info: unknown = await response.json();
      if (!isBuildInfo(info)) throw new Error('部署版本信息无效');
      deployed = info;
      if (state.candidate?.buildId !== info.buildId) state.candidate = null;
      await registration!.update();
      await inspectWaiting();
      if (state.candidate) return;
      set(
        info.buildId === build.buildId ? 'current' : 'preparing',
        info.buildId === build.buildId ? '当前已是最新版' : '新版正在准备，下载完成后会提示更新',
      );
    })()
      .catch(() => {
        set(
          online() ? 'error' : 'offline',
          online() ? '检查更新失败，请稍后重试' : '当前离线，联网后可以检查更新',
        );
      })
      .finally(() => {
        clearTimeout(checkTimeout);
        checking = undefined;
      });
    return checking;
  }
  function apply(): Promise<void> {
    if (applying) return applying;
    if (checking) return checking.then(() => apply());
    if (!state.candidate || !registration?.waiting) {
      set('error', '新版尚未准备好，请先检查更新');
      return Promise.resolve();
    }
    const reason = acquireUpdateLock();
    if (reason) {
      state.message = reason;
      return Promise.resolve();
    }
    const target = state.candidate.buildId;
    const waiting = registration.waiting;
    expected = target;
    set('updating', '正在更新，请稍候…');
    applying = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removeActivationListener: (() => void) | undefined;
      try {
        const activation = (async () => {
          const reply = await messageWorker(
            waiting,
            {
              type: 'SIMCARE_ACTIVATE',
              buildId: target,
              expiresAt: Date.now() + (env.timeout ?? 15000),
            },
            env.timeout ?? 15000,
          );
          if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true) {
            const code =
              reply && typeof reply === 'object' && 'reason' in reply ? reply.reason : '';
            throw new Error(
              code === 'other-clients'
                ? '请先保存并关闭其他简护页面或窗口，再点击更新'
                : '新版已变化，请重新检查更新',
            );
          }
          if (await confirmController()) return;
          await new Promise<void>((resolve) => {
            const listener = () => {
              void confirmController().then((done) => {
                if (done) {
                  env.serviceWorker.removeEventListener('controllerchange', listener);
                  resolve();
                }
              });
            };
            env.serviceWorker.addEventListener('controllerchange', listener);
            removeActivationListener = () =>
              env.serviceWorker.removeEventListener('controllerchange', listener);
            listener();
          });
        })();
        await Promise.race([
          activation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('更新响应超时，请重试')),
              env.timeout ?? 15000,
            );
          }),
        ]);
      } catch (reason) {
        if (!(await confirmController()))
          set('error', reason instanceof Error ? reason.message : '更新失败，请重试');
      } finally {
        clearTimeout(timer);
        removeActivationListener?.();
        if (!reloaded) {
          expected = undefined;
          releaseUpdateLock();
        }
      }
    })().finally(() => {
      applying = undefined;
    });
    return applying;
  }
  return {
    state,
    check,
    apply,
    dismiss: () => {
      state.dismissed = state.candidate?.buildId ?? '';
    },
    dispose: () => {
      disposed = true;
      removers.forEach((remove) => remove());
      expected = undefined;
      releaseUpdateLock();
    },
  };
}
export const updates =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? createUpdateManager({ serviceWorker: navigator.serviceWorker })
    : undefined;
export function startUpdates() {
  if (!updates || !import.meta.env.PROD) return;
  const check = () => {
    if (!document.hidden) void updates.check();
  };
  window.addEventListener('online', check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  window.setInterval(check, 15 * 60_000);
  check();
}
