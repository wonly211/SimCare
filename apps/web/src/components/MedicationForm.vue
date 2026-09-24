<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { Check, LoaderCircle, Plus, Trash2 } from 'lucide-vue-next';
import {
  beijingDate,
  labels,
  medicationInputSchema,
  type Medication,
  type MedicationInput,
  type MedicationSchedule,
  type Member,
} from '@simcare/shared';
import ModalDialog from './ModalDialog.vue';
import { saveMedication } from '../sync';
import { errorMessage, notify, savedMessage } from '../state/client';
const props = defineProps<{ medication?: Medication; ownerId: string; members: Member[] }>();
const emit = defineEmits<{ close: []; saved: [] }>();
function newSchedule(): MedicationSchedule {
  return {
    id: crypto.randomUUID(),
    period: 'morning',
    time: null,
    dose: '',
    unit: '片',
    meal: 'any',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  };
}
const input = reactive<MedicationInput>({
  ownerId: props.medication?.ownerId ?? props.ownerId,
  name: props.medication?.name ?? '',
  specification: props.medication?.specification ?? '',
  form: props.medication?.form ?? '片剂',
  route: props.medication?.route ?? '口服',
  reason: props.medication?.reason ?? '',
  note: props.medication?.note ?? '',
  startDate: props.medication?.startDate ?? beijingDate(),
  endDate: props.medication?.endDate ?? null,
  status: props.medication?.status ?? 'active',
  schedules: props.medication
    ? (JSON.parse(JSON.stringify(props.medication.schedules)) as MedicationSchedule[])
    : [newSchedule()],
});
const weekdays = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
];
const memberName = computed(
  () => props.members.find((member) => member.id === input.ownerId)?.nickname ?? '当前成员',
);
const initial = JSON.stringify(input);
const dirty = computed(() => JSON.stringify(input) !== initial);
const modal = ref<InstanceType<typeof ModalDialog>>();
const saving = ref(false);
const error = ref('');
async function submit() {
  error.value = '';
  const candidate = {
    ...input,
    endDate: input.endDate || null,
    schedules: input.schedules.map((schedule) => ({
      ...schedule,
      time: schedule.period === 'time' ? schedule.time : null,
    })),
  };
  const result = medicationInputSchema.safeParse(candidate);
  if (!result.success) {
    error.value = '请检查药品名称、单次用量、日期和用药时间；每项计划至少选择一天。';
    return;
  }
  saving.value = true;
  try {
    await saveMedication(result.data, props.medication?.id, props.medication?.version);
    savedMessage.value = '用药计划已保存在这台设备，联网后会自动同步。';
    notify('用药计划已保存到本机');
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
    :title="medication ? '编辑用药计划' : '添加用药计划'"
    wide
    fullscreen
    :dirty="dirty"
    :busy="saving"
    @close="emit('close')"
  >
    <form class="form-stack" @submit.prevent="submit">
      <div class="form-grid">
        <p class="record-owner">
          记录归属：<strong>{{ memberName }}</strong>
        </p>
        <label
          >状态<select v-model="input.status">
            <option v-for="(text, value) in labels.status" :key="value" :value="value">
              {{ text }}
            </option>
          </select></label
        >
      </div>
      <div class="form-grid">
        <label>药品名称<input v-model="input.name" maxlength="100" required /></label
        ><label
          >药品规格<input v-model="input.specification" maxlength="100" placeholder="例如：5 mg/片"
        /></label>
      </div>
      <div class="form-grid">
        <label
          >剂型<select v-model="input.form">
            <option>片剂</option>
            <option>胶囊</option>
            <option>颗粒</option>
            <option>口服液</option>
            <option>滴剂</option>
            <option>其他</option>
          </select></label
        ><label
          >使用方式<select v-model="input.route">
            <option>口服</option>
            <option>外用</option>
            <option>注射</option>
            <option>吸入</option>
            <option>其他</option>
          </select></label
        >
      </div>
      <div class="form-grid">
        <label>开始日期<input v-model="input.startDate" type="date" required /></label
        ><label
          >结束日期（选填）<input v-model="input.endDate" type="date" :min="input.startDate"
        /></label>
      </div>
      <fieldset class="schedules">
        <legend>用药时间与用量</legend>
        <div
          v-for="(schedule, index) in input.schedules"
          :key="schedule.id"
          class="schedule-editor"
        >
          <div class="schedule-editor-header">
            <strong>计划 {{ index + 1 }}</strong
            ><button
              v-if="input.schedules.length > 1"
              type="button"
              class="icon-button danger"
              title="移除此用药时间"
              aria-label="移除此用药时间"
              @click="input.schedules.splice(index, 1)"
            >
              <Trash2 :size="16" />
            </button>
          </div>
          <div class="form-grid">
            <label
              >时段<select v-model="schedule.period">
                <option v-for="(text, value) in labels.period" :key="value" :value="value">
                  {{ text }}
                </option>
              </select></label
            ><label v-if="schedule.period === 'time'"
              >具体时间<input v-model="schedule.time" type="time" required /></label
            ><label v-else
              >进餐关系<select v-model="schedule.meal">
                <option v-for="(text, value) in labels.meal" :key="value" :value="value">
                  {{ text }}
                </option>
              </select></label
            >
          </div>
          <div class="form-grid form-grid-three">
            <label
              >本次用量<input
                v-model="schedule.dose"
                maxlength="40"
                placeholder="例如：0.5"
                required /></label
            ><label
              >单位<input
                v-model="schedule.unit"
                list="dose-units"
                maxlength="20"
                required /></label
            ><label v-if="schedule.period === 'time'"
              >进餐关系<select v-model="schedule.meal">
                <option v-for="(text, value) in labels.meal" :key="value" :value="value">
                  {{ text }}
                </option>
              </select></label
            >
          </div>
          <div class="weekday-row">
            <label v-for="day in weekdays" :key="day.value" class="weekday"
              ><input v-model="schedule.weekdays" type="checkbox" :value="day.value" /><span>{{
                day.label
              }}</span></label
            >
          </div>
        </div>
        <button
          type="button"
          class="button secondary"
          :disabled="input.schedules.length >= 12"
          @click="input.schedules.push(newSchedule())"
        >
          <Plus :size="16" />增加用药时间
        </button>
      </fieldset>
      <datalist id="dose-units">
        <option>片</option>
        <option>粒</option>
        <option>袋</option>
        <option>ml</option>
        <option>滴</option>
        <option>mg</option>
      </datalist>
      <label>用药原因（选填）<input v-model="input.reason" maxlength="200" /></label
      ><label>备注<textarea v-model="input.note" rows="2" maxlength="2000" /></label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer class="modal-actions">
        <button type="button" class="button secondary" @click="modal?.close()">取消</button
        ><button type="submit" class="button primary" :disabled="saving">
          <LoaderCircle v-if="saving" class="spin" :size="17" /><Check v-else :size="17" />保存计划
        </button>
      </footer>
    </form>
  </ModalDialog>
</template>
