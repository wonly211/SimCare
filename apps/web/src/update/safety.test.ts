import { afterEach, describe, expect, it } from 'vitest';
import { effectScope, ref } from 'vue';
import {
  acquireUpdateLock,
  protectedOperation,
  releaseUpdateLock,
  updateBlockedReason,
  updateSafety,
  useUpdateGuard,
} from './safety';
afterEach(releaseUpdateLock);
describe('更新保护', () => {
  it('跟踪表单修改、忙碌状态和卸载清理', () => {
    const scope = effectScope(),
      dirty = ref(true),
      busy = ref(false);
    scope.run(() =>
      useUpdateGuard(
        () => dirty.value,
        () => busy.value,
      ),
    );
    expect(acquireUpdateLock()).toContain('保存或取消');
    busy.value = true;
    expect(updateBlockedReason.value).toContain('处理数据');
    dirty.value = false;
    busy.value = false;
    expect(acquireUpdateLock()).toBe('');
    releaseUpdateLock();
    dirty.value = true;
    scope.stop();
    expect(acquireUpdateLock()).toBe('');
  });
  it('事务执行期间禁止激活，失败后计数归零，激活锁阻止新写入', async () => {
    let finish!: () => void;
    const work = protectedOperation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(updateSafety.operations).toBe(1);
    expect(acquireUpdateLock()).toContain('处理数据');
    finish();
    await work;
    expect(updateSafety.operations).toBe(0);
    await expect(
      protectedOperation(async () => {
        throw Error('test');
      }),
    ).rejects.toThrow('test');
    expect(updateSafety.operations).toBe(0);
    expect(acquireUpdateLock()).toBe('');
    await expect(protectedOperation(async () => 1)).rejects.toThrow('正在更新');
    releaseUpdateLock();
    expect(await protectedOperation(async () => 1)).toBe(1);
  });
});
