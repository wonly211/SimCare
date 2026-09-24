<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue';
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
import { errorMessage, notify, savedMessage } from '../state/client';
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
const initial = JSON.stringify(input);
const dirty = computed(() => JSON.stringify(input) !== initial);
const memberName = computed(
  () => props.members.find((member) => member.id === input.ownerId)?.nickname ?? '当前成员',
);
const modal = ref<InstanceType<typeof ModalDialog>>();
const saving = ref(false),
  error = ref('');
const extra = ref(
  !!props.record &&
    (props.record.oxygen !== null ||
      props.record.temperature !== null ||
      props.record.posture !== 'unspecified' ||
      props.record.arm !== 'unspecified' ||
      !!props.record.note),
);
const fieldErrors = ref<Record<string, string>>({});
const numberOrNull = (value: string | number) => (value === '' ? null : Number(value));
const metrics = [
  { key: 'systolic', label: '高压（收缩压）', unit: 'mmHg', step: '1' },
  { key: 'diastolic', label: '低压（舒张压）', unit: 'mmHg', step: '1' },
  { key: 'pulse', label: '心率', unit: '次/分', step: '1' },
  { key: 'oxygen', label: '血氧', unit: '%', step: '0.1' },
  { key: 'temperature', label: '体温', unit: '℃', step: '0.1' },
] as const;
async function submit() {
  error.value = '';
  fieldErrors.value = {};
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
    for (const issue of result.error.issues)
      fieldErrors.value[
        String(
          issue.path[0] ??
            (input.systolic !== '' && input.diastolic === '' ? 'diastolic' : 'systolic'),
        )
      ] = issue.message;
    error.value = '请检查标出的测量项目，已填写的内容会保留。';
    if (
      Object.keys(fieldErrors.value).some((key) =>
        ['oxygen', 'temperature', 'posture', 'arm', 'note'].includes(key),
      )
    )
      extra.value = true;
    await nextTick();
    document.getElementById(`health-${Object.keys(fieldErrors.value)[0]}`)?.focus();
    return;
  }
  saving.value = true;
  try {
    await saveHealth(result.data, props.record?.id, props.record?.version);
    savedMessage.value = `${memberName.value}的测量记录已保存在这台设备，联网后会自动同步。`;
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
  <ModalDialog
    ref="modal"
    :title="`${record ? '编辑' : '为'}${memberName}${record ? '的测量记录' : '记录测量'}`"
    fullscreen
    :dirty="dirty"
    :busy="saving"
    @close="emit('close')"
  >
    <form class="form-stack" novalidate @submit.prevent="submit">
      <p class="record-owner">
        记录归属：<strong>{{ memberName }}</strong>
      </p>
      <label for="health-measuredAt">测量时间 · 北京时间</label
      ><input
        id="health-measuredAt"
        v-model="input.measuredAt"
        type="datetime-local"
        required
        :aria-invalid="!!fieldErrors.measuredAt"
        :aria-describedby="fieldErrors.measuredAt ? 'error-measuredAt' : undefined"
      />
      <p v-if="fieldErrors.measuredAt" id="error-measuredAt" class="form-error">
        {{ fieldErrors.measuredAt }}
      </p>
      <template v-for="metric in metrics.slice(0, 3)" :key="metric.key"
        ><label :for="`health-${metric.key}`">{{ metric.label }} · {{ metric.unit }}</label
        ><input
          :id="`health-${metric.key}`"
          v-model="input[metric.key]"
          type="number"
          inputmode="numeric"
          :step="metric.step"
          :aria-invalid="!!fieldErrors[metric.key]"
          :aria-describedby="fieldErrors[metric.key] ? `error-${metric.key}` : undefined"
        />
        <p v-if="fieldErrors[metric.key]" :id="`error-${metric.key}`" class="form-error">
          {{ fieldErrors[metric.key] }}
        </p></template
      >
      <button
        type="button"
        class="button secondary"
        :aria-expanded="extra"
        aria-controls="extra-measurements"
        @click="extra = !extra"
      >
        {{ extra ? '收起' : '展开' }}血氧、体温与补充说明
      </button>
      <div v-show="extra" id="extra-measurements" class="form-stack">
        <template v-for="metric in metrics.slice(3)" :key="metric.key"
          ><label :for="`health-${metric.key}`">{{ metric.label }} · {{ metric.unit }}</label
          ><input
            :id="`health-${metric.key}`"
            v-model="input[metric.key]"
            type="number"
            inputmode="decimal"
            :step="metric.step"
            :aria-invalid="!!fieldErrors[metric.key]"
            :aria-describedby="fieldErrors[metric.key] ? `error-${metric.key}` : undefined"
          />
          <p v-if="fieldErrors[metric.key]" :id="`error-${metric.key}`" class="form-error">
            {{ fieldErrors[metric.key] }}
          </p></template
        >
        <label
          >测量姿势<select id="health-posture" v-model="input.posture">
            <option v-for="(text, value) in labels.posture" :key="value" :value="value">
              {{ text }}
            </option>
          </select></label
        >
        <label
          >测量手臂<select id="health-arm" v-model="input.arm">
            <option v-for="(text, value) in labels.arm" :key="value" :value="value">
              {{ text }}
            </option>
          </select></label
        >
        <label
          >备注<textarea id="health-note" v-model="input.note" rows="3" maxlength="2000" />
        </label>
      </div>
      <p class="muted">只填写本次测量的项目即可。填写血压时，请同时填写高压和低压。</p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer class="modal-actions">
        <button type="button" class="button secondary" :disabled="saving" @click="modal?.close()">
          取消</button
        ><button type="submit" class="button primary" :disabled="saving">
          <LoaderCircle v-if="saving" class="spin" :size="20" /><Check v-else :size="20" />保存记录
        </button>
      </footer>
    </form>
  </ModalDialog>
</template>
