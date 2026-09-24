import { computed, onScopeDispose, reactive, watchEffect } from 'vue';
const guards = reactive(new Map<symbol, { dirty: boolean; busy: boolean }>());
export const updateSafety = reactive({ locked: false, operations: 0 });
export const updateBlockedReason = computed(() => {
  if (updateSafety.operations || [...guards.values()].some((g) => g.busy))
    return '正在保存、同步或处理数据，请完成后再更新';
  if ([...guards.values()].some((g) => g.dirty)) return '请先保存或取消当前修改';
  return '';
});
export function useUpdateGuard(dirty: () => boolean, busy: () => boolean = () => false) {
  const id = Symbol();
  watchEffect(
    () => {
      guards.set(id, { dirty: dirty(), busy: busy() });
    },
    { flush: 'sync' },
  );
  onScopeDispose(() => guards.delete(id));
}
export async function protectedOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (updateSafety.locked) throw new Error('正在更新，请稍候再操作');
  updateSafety.operations++;
  try {
    return await operation();
  } finally {
    updateSafety.operations--;
  }
}
export function acquireUpdateLock(): string {
  if (updateSafety.locked) return '正在更新，请稍候';
  const reason = updateBlockedReason.value;
  if (reason) return reason;
  updateSafety.locked = true;
  return '';
}
export function releaseUpdateLock() {
  updateSafety.locked = false;
}
