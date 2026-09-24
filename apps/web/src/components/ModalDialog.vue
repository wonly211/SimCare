<script setup lang="ts">
import { inject, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { matchedRouteKey, onBeforeRouteLeave } from 'vue-router';
import { useUpdateGuard } from '../update/safety';
import { X } from 'lucide-vue-next';
const props = defineProps<{
  title: string;
  wide?: boolean;
  fullscreen?: boolean;
  dirty?: boolean;
  busy?: boolean;
}>();
useUpdateGuard(
  () => !!props.dirty,
  () => !!props.busy,
);
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const heading = ref<HTMLElement>();
const titleId = useId();
let previous: HTMLElement | null = null;
function mayLeave() {
  return !props.busy && (!props.dirty || window.confirm('还有未保存的内容。确定放弃这次修改吗？'));
}
function close() {
  if (mayLeave()) emit('close');
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (props.dirty || props.busy) {
    event.preventDefault();
    event.returnValue = '';
  }
}
if (inject(matchedRouteKey, undefined)?.value) onBeforeRouteLeave(() => mayLeave());
onMounted(async () => {
  previous = document.activeElement as HTMLElement;
  dialog.value?.showModal();
  await nextTick();
  heading.value?.focus();
  window.addEventListener('beforeunload', beforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  dialog.value?.close();
  if (previous?.isConnected) previous.focus();
});
defineExpose({ close });
</script>
<template>
  <dialog
    ref="dialog"
    :class="['modal', { 'modal-wide': wide, 'modal-fullscreen': fullscreen }]"
    :aria-labelledby="titleId"
    @cancel.prevent="close"
    @click="
      (event) => {
        if (event.target === dialog && !fullscreen) close();
      }
    "
  >
    <div class="modal-content">
      <header class="modal-header">
        <h2 :id="titleId" ref="heading" tabindex="-1">{{ title }}</h2>
        <button class="icon-button" title="关闭" aria-label="关闭" :disabled="busy" @click="close">
          <X :size="20" />
        </button>
      </header>
      <slot />
    </div>
  </dialog>
</template>
