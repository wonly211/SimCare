<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Moon,
  Pill,
  Plus,
  Sun,
  Sunrise,
} from 'lucide-vue-next';
import {
  beijingDate,
  canEditOwned,
  labels,
  todayMedication,
  type Medication,
} from '@simcare/shared';
import { state, deleteRecord } from '../sync';
import MedicationForm from '../components/MedicationForm.vue';
import ModalDialog from '../components/ModalDialog.vue';
import RecordDetails from '../components/RecordDetails.vue';
import { errorMessage, notify, today } from '../state/client';
const props = defineProps<{ ownerId: string }>();
const tab = ref<'today' | 'list'>('today');
const day = ref(beijingDate());
watch(today, (next, previous) => {
  if (day.value === previous) day.value = next;
});
const status = ref('active');
const formOpen = ref(false);
const editing = ref<Medication>();
const detail = ref<Medication>();
const removing = ref<Medication>();
const busy = ref(false);
const medications = computed(() =>
  (state.snapshot?.medications ?? []).filter(
    (item) => item.ownerId === props.ownerId && !item.deletedAt,
  ),
);
const filtered = computed(() =>
  medications.value.filter((item) => status.value === 'all' || item.status === status.value),
);
const doses = computed(() => todayMedication(medications.value, day.value));
const writableMembers = computed(() =>
  (state.snapshot?.members ?? []).filter(
    (member) => member.active && state.session && canEditOwned(state.session.user, member.id),
  ),
);
const canEdit = computed(() => !!state.session && canEditOwned(state.session.user, props.ownerId));
const groups = computed(() => {
  const result: { label: string; icon: typeof Sun; doses: typeof doses.value }[] = [];
  for (const dose of doses.value) {
    const hour = Number(dose.sortTime.slice(0, 2));
    const label =
      dose.schedule.period === 'as_needed'
        ? '按需用药'
        : hour < 11
          ? '早间'
          : hour < 16
            ? '午间'
            : '晚间';
    let group = result.find((item) => item.label === label);
    if (!group) {
      group = {
        label,
        icon: label === '早间' ? Sunrise : label === '午间' ? Sun : label === '晚间' ? Moon : Pill,
        doses: [],
      };
      result.push(group);
    }
    group.doses.push(dose);
  }
  return result;
});
function changeDate(offset: number) {
  const next = new Date(`${day.value}T12:00:00+08:00`);
  next.setTime(next.getTime() + offset * 86400000);
  day.value = beijingDate(next);
}
function openForm(medication?: Medication) {
  editing.value = medication;
  formOpen.value = true;
}
async function remove() {
  if (!removing.value) return;
  busy.value = true;
  try {
    await deleteRecord('medication', removing.value.id, removing.value.version);
    removing.value = undefined;
    notify('用药计划已移除，历史保留');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="page-section">
    <div class="section-heading">
      <div>
        <p class="eyebrow">用药计划</p>
        <h1>用药清单</h1>
      </div>
      <button v-if="canEdit" class="button primary" @click="openForm()">
        <Plus :size="18" />添加用药
      </button>
    </div>
    <div class="toolbar">
      <div class="segmented">
        <button :class="{ active: tab === 'today' }" @click="tab = 'today'">
          <Clock3 :size="16" />当日安排</button
        ><button :class="{ active: tab === 'list' }" @click="tab = 'list'">
          <Pill :size="16" />全部用药
        </button>
      </div>
      <div v-if="tab === 'today'" class="day-picker">
        <button class="icon-button" title="前一天" aria-label="前一天" @click="changeDate(-1)">
          <ChevronLeft :size="18" /></button
        ><input v-model="day" type="date" aria-label="用药日期" required /><button
          class="icon-button"
          title="后一天"
          aria-label="后一天"
          @click="changeDate(1)"
        >
          <ChevronRight :size="18" /></button
        ><button class="text-button" @click="day = beijingDate()">
          {{ day === today ? '今天' : '回到今天' }}
        </button>
      </div>
      <select v-else v-model="status" aria-label="用药状态">
        <option value="active">使用中</option>
        <option value="paused">暂停</option>
        <option value="completed">已完成</option>
        <option value="all">所有状态</option>
      </select>
    </div>
    <template v-if="tab === 'today'">
      <div class="plan-summary">
        <CalendarDays :size="21" />
        <div>
          <strong>{{ day === beijingDate() ? '今日用药计划' : `${day} 用药计划` }}</strong
          ><span
            >{{ doses.length }} 次安排 ·
            {{ new Set(doses.map((item) => item.medication.id)).size }} 种药品</span
          >
        </div>
        <span class="badge neutral">计划，不代表已服药</span>
      </div>
      <div v-if="!doses.length" class="empty-state">
        <Pill :size="36" />
        <h3>当天暂无用药安排</h3>
        <p>当前没有适用于这一天的用药计划。</p>
        <button v-if="canEdit" class="button secondary" @click="openForm()">
          <Plus :size="16" />添加用药计划
        </button>
      </div>
      <div v-else class="medication-timeline">
        <section v-for="group in groups" :key="group.label" class="time-group">
          <div class="time-group-label">
            <component :is="group.icon" :size="20" />
            <h2>{{ group.label }}</h2>
          </div>
          <article
            v-for="dose in group.doses"
            :key="`${dose.medication.id}-${dose.schedule.id}`"
            class="dose-row"
          >
            <div class="dose-time">
              {{
                dose.schedule.period === 'time'
                  ? dose.schedule.time
                  : labels.period[dose.schedule.period]
              }}<span>{{ labels.meal[dose.schedule.meal] }}</span>
            </div>
            <div class="dose-info">
              <h3>{{ dose.medication.name }}</h3>
              <p>
                {{ dose.medication.specification || '规格未填写' }} ·
                {{ dose.medication.route || '用法未填写' }}
              </p>
              <p v-if="dose.medication.note" class="dose-note">{{ dose.medication.note }}</p>
            </div>
            <div class="dose-amount">
              <span>每次</span><strong>{{ dose.schedule.dose }}</strong
              ><span>{{ dose.schedule.unit }}</span>
            </div>
            <button class="button secondary" @click="detail = dose.medication">查看用药详情</button>
          </article>
        </section>
      </div>
    </template>
    <template v-else
      ><div v-if="!filtered.length" class="empty-state">
        <Pill :size="36" />
        <h3>
          暂无{{ status === 'all' ? '' : labels.status[status as keyof typeof labels.status] }}药品
        </h3>
      </div>
      <div v-else class="medication-list">
        <article v-for="medication in filtered" :key="medication.id" class="medicine-row">
          <span class="medicine-symbol"><Pill :size="24" /></span>
          <div class="medicine-content">
            <h3>
              {{ medication.name
              }}<span
                class="badge"
                :class="medication.status === 'active' ? 'success' : 'neutral'"
                >{{ labels.status[medication.status] }}</span
              >
            </h3>
            <p>
              {{ medication.specification || '规格未填写' }} · {{ medication.form }} ·
              {{ medication.route }}
            </p>
            <div class="schedule-tags">
              <span v-for="schedule in medication.schedules" :key="schedule.id"
                >{{ schedule.time || labels.period[schedule.period] }} · {{ schedule.dose }}
                {{ schedule.unit }} · {{ labels.meal[schedule.meal] }}</span
              >
            </div>
            <p class="medicine-dates">
              {{ medication.startDate }} 起{{
                medication.endDate ? `，至 ${medication.endDate}` : ''
              }}
            </p>
          </div>
          <button class="button secondary" @click="detail = medication">查看用药详情</button>
        </article>
      </div></template
    >
    <ModalDialog v-if="detail" :title="detail.name" @close="detail = undefined"
      ><RecordDetails :record="detail" />
      <div v-if="canEdit" class="modal-actions">
        <button
          class="button secondary"
          @click="
            openForm(detail);
            detail = undefined;
          "
        >
          修改计划</button
        ><button
          class="button danger-button"
          @click="
            removing = detail;
            detail = undefined;
          "
        >
          移除用药计划
        </button>
      </div></ModalDialog
    >
    <MedicationForm
      v-if="formOpen"
      :medication="editing"
      :owner-id="ownerId"
      :members="writableMembers"
      @close="formOpen = false"
    />
    <ModalDialog v-if="removing" title="移除用药计划" @close="removing = undefined"
      ><p class="modal-description">确认移除 {{ removing.name }}？修改历史仍会保留。</p>
      <footer class="modal-actions">
        <button class="button secondary" @click="removing = undefined">取消</button
        ><button class="button danger-button" :disabled="busy" @click="remove">确认移除</button>
      </footer></ModalDialog
    >
  </section>
</template>
