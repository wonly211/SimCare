<script setup lang="ts">
import { onMounted, ref, useId } from 'vue';
import { X } from 'lucide-vue-next';
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const titleId = useId();
onMounted(() => dialog.value?.showModal());
</script>
<template>
  <dialog
    ref="dialog"
    :class="['modal', { 'modal-wide': wide }]"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
    @click="
      (event) => {
        if (event.target === dialog) emit('close');
      }
    "
  >
    <div class="modal-content">
      <header class="modal-header">
        <h2 :id="titleId">{{ title }}</h2>
        <button class="icon-button" title="关闭" aria-label="关闭" @click="emit('close')">
          <X :size="20" />
        </button>
      </header>
      <slot />
    </div>
  </dialog>
</template>
