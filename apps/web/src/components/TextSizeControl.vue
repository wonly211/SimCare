<script setup lang="ts">
import { textSize, textSizes, setTextSize } from '../state/display';
</script>
<template>
  <fieldset class="text-size-control">
    <legend>字体大小</legend>
    <div class="segmented" aria-label="字体大小">
      <button
        v-for="size in textSizes"
        :key="size.value"
        type="button"
        :aria-pressed="textSize === size.value"
        :class="{ active: textSize === size.value }"
        @click="setTextSize(size.value)"
      >
        {{ size.label }}
      </button>
    </div>
  </fieldset>
</template>
