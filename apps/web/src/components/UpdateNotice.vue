<script setup lang="ts">
import { computed } from 'vue';
import { updates } from '../update/manager';
import { currentBuild } from '../update/build';
import { updateBlockedReason, updateSafety } from '../update/safety';
const props = defineProps<{ settings?: boolean }>();
const state = updates?.state;
const visible = computed(
  () => props.settings || (!!state?.candidate && state.dismissed !== state.candidate.buildId),
);
</script>
<template>
  <section
    v-if="visible"
    :class="['update-notice', { 'settings-section': settings }]"
    aria-label="应用更新"
  >
    <h2>{{ settings ? '应用版本与更新' : '简护有新版本，可以更新了' }}</h2>
    <template v-if="settings"
      ><p>当前版本 {{ currentBuild.version }}</p>
      <p class="build-id">构建标识：{{ currentBuild.buildId }}</p></template
    >
    <p role="status" aria-live="polite">{{ state?.message || '可在联网时检查是否有新版本' }}</p>
    <p v-if="state?.candidate && updateBlockedReason" class="muted">{{ updateBlockedReason }}</p>
    <div class="update-actions">
      <button
        v-if="settings"
        class="button secondary"
        :disabled="!updates || state?.status === 'checking' || updateSafety.locked"
        @click="updates?.check(true)"
      >
        检查更新
      </button>
      <button
        v-if="state?.candidate"
        class="button primary"
        :disabled="!!updateBlockedReason || updateSafety.locked"
        @click="updates?.apply()"
      >
        立即更新
      </button>
      <button
        v-if="!settings"
        class="button secondary"
        :disabled="updateSafety.locked"
        @click="updates?.dismiss()"
      >
        稍后
      </button>
    </div>
    <p v-if="!updates" class="muted">此浏览器暂不支持应用内更新，请使用支持 PWA 的浏览器。</p>
  </section>
</template>
