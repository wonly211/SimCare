<script setup lang="ts">
import { reactive, ref } from 'vue';
import { Check, LoaderCircle } from 'lucide-vue-next';
import {
  beijingNow,
  healthInputSchema,
  labels,
  type HealthInput,
  type HealthRecord,
  type Member,
} from '@simcare/shared';
import ModalDialog from './ModalDialog.vue';
import { saveHealth } from '../sync';
import { errorMessage, notify } from '../state/client';
const props = defineProps<{ record?: HealthRecord; ownerId: string; members: Member[] }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const input = reactive({
  ownerId: props.record?.ownerId ?? props.ownerId,
  measuredAt: (props.record?.measuredAt ?? beijingNow()).slice(0, 16),
  systolic: props.record?.systolic ?? '',
  diastolic: props.record?.diastolic ?? '',
  pulse: props.record?.pulse ?? '',
  oxygen: props.record?.oxygen ?? '',
  temperature: props.record?.temperature ?? '',
  posture: props.record?.posture ?? 'unspecified',
  arm: props.record?.arm ?? 'unspecified',
  note: props.record?.note ?? '',
});
const saving = ref(false);
const error = ref('');
const numberOrNull = (value: string | number) => (value === '' ? null : Number(value));
async function submit() {
  error.value = '';
  const candidate: HealthInput = {
    ...input,
    measuredAt: `${input.measuredAt}:00+08:00`,
    systolic: numberOrNull(input.systolic),
    diastolic: numberOrNull(input.diastolic),
    pulse: numberOrNull(input.pulse),
    oxygen: numberOrNull(input.oxygen),
    temperature: numberOrNull(input.temperature),
  };
  const result = healthInputSchema.safeParse(candidate);
  if (!result.success) {
    error.value = result.error.issues.map((item) => item.message).join('；');
    return;
  }
  saving.value = true;
  try {
    await saveHealth(result.data, props.record?.id, props.record?.version);
    notify('记录已保存到本机');
    emit('saved');
    emit('close');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <ModalDialog :title="record ? '编辑健康记录' : '新增健康记录'" @close="emit('close')">
    <form class="form-stack" @submit.prevent="submit">
      <div class="form-grid">
        <label
          >家庭成员<select v-model="input.ownerId" :disabled="!!record" required>
            <option v-for="member in members" :key="member.id" :value="member.id">
              {{ member.nickname }}
            </option>
          </select></label
        >
        <label
          >测量时间 · 北京时间<input v-model="input.measuredAt" type="datetime-local" required
        /></label>
      </div>
      <fieldset>
        <legend>血压</legend>
        <div class="form-grid">
          <label
            >收缩压<span class="unit-input"
              ><input
                v-model="input.systolic"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                placeholder="—"
              /><span>mmHg</span></span
            ></label
          >
          <label
            >舒张压<span class="unit-input"
              ><input
                v-model="input.diastolic"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
                placeholder="—"
              /><span>mmHg</span></span
            ></label
          >
        </div>
      </fieldset>
      <div class="form-grid form-grid-three">
        <label
          >心率<span class="unit-input"
            ><input
              v-model="input.pulse"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              placeholder="—"
            /><span>bpm</span></span
          ></label
        >
        <label
          >血氧<span class="unit-input"
            ><input
              v-model="input.oxygen"
              type="number"
              min="0"
              max="100"
              step="0.1"
              inputmode="decimal"
              placeholder="—"
            /><span>%</span></span
          ></label
        >
        <label
          >体温<span class="unit-input"
            ><input
              v-model="input.temperature"
              type="number"
              step="0.1"
              inputmode="decimal"
              placeholder="—"
            /><span>°C</span></span
          ></label
        >
      </div>
      <div class="form-grid">
        <label
          >测量姿势<select v-model="input.posture">
            <option v-for="(text, value) in labels.posture" :key="value" :value="value">
              {{ text }}
            </option>
          </select></label
        >
        <label
          >测量手臂<select v-model="input.arm">
            <option v-for="(text, value) in labels.arm" :key="value" :value="value">
              {{ text }}
            </option>
          </select></label
        >
      </div>
      <label
        >备注<textarea
          v-model="input.note"
          rows="3"
          maxlength="2000"
          placeholder="本次测量的补充信息（选填）"
        />
      </label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer class="modal-actions">
        <button type="button" class="button secondary" @click="emit('close')">取消</button
        ><button type="submit" class="button primary" :disabled="saving">
          <LoaderCircle v-if="saving" class="spin" :size="17" /><Check v-else :size="17" />保存记录
        </button>
      </footer>
    </form>
  </ModalDialog>
</template>
