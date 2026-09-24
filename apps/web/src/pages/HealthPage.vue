<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Activity,
  CalendarDays,
  ChartNoAxesCombined,
  History,
  List,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-vue-next';
import {
  canCreateHealth,
  canEditOwned,
  canViewHealth,
  labels,
  type HealthRecord,
  type Revision,
} from '@simcare/shared';
import { state, deleteRecord, restoreRecord } from '../sync';
import HealthForm from '../components/HealthForm.vue';
import TrendChart from '../components/TrendChart.vue';
import ModalDialog from '../components/ModalDialog.vue';
import { api, displayTime, errorMessage, notify } from '../state/client';

const props = defineProps<{ ownerId: string }>();
const tab = ref<'records' | 'trend'>('records');
const deleted = ref(false);
const fromDate = ref('');
const toDate = ref('');
const metric = ref<'pressure' | 'pulse' | 'oxygen' | 'temperature'>('pressure');
const editing = ref<HealthRecord>();
const formOpen = ref(false);
const historyRecord = ref<HealthRecord>();
const revisions = ref<Revision<HealthRecord>[]>([]);
const historyError = ref('');
const pendingAction = ref<{ record: HealthRecord; restore: boolean }>();
const busy = ref(false);
const visible = computed(
  () =>
    !!state.session &&
    canViewHealth(state.session.user, props.ownerId, state.snapshot?.grants ?? []),
);
const writableMembers = computed(() =>
  (state.snapshot?.members ?? []).filter(
    (member) =>
      member.active &&
      state.session &&
      canCreateHealth(state.session.user, member.id, state.snapshot?.grants ?? []),
  ),
);
const canCreate = computed(() =>
  writableMembers.value.some((member) => member.id === props.ownerId),
);
const records = computed(() =>
  (state.snapshot?.healthRecords ?? [])
    .filter(
      (record) =>
        record.ownerId === props.ownerId &&
        !!record.deletedAt === deleted.value &&
        (!fromDate.value || record.measuredAt.slice(0, 10) >= fromDate.value) &&
        (!toDate.value || record.measuredAt.slice(0, 10) <= toDate.value),
    )
    .sort((left, right) => right.measuredAt.localeCompare(left.measuredAt)),
);
const ownerName = (id: string) =>
  state.snapshot?.members.find((member) => member.id === id)?.nickname ?? '成员';
function openForm(record?: HealthRecord) {
  editing.value = record;
  formOpen.value = true;
}
async function historyFor(record: HealthRecord) {
  historyRecord.value = record;
  revisions.value = [];
  historyError.value = '';
  try {
    revisions.value = await api<Revision<HealthRecord>[]>(`/health-records/${record.id}/history`);
  } catch (reason) {
    historyError.value = errorMessage(reason);
  }
}
async function confirmAction() {
  if (!pendingAction.value) return;
  busy.value = true;
  try {
    const { record, restore } = pendingAction.value;
    if (restore) await restoreRecord('health', record.id, record.version);
    else await deleteRecord('health', record.id, record.version);
    notify(restore ? '记录已恢复' : '记录已移入已删除');
    pendingAction.value = undefined;
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
        <p class="eyebrow">测量档案</p>
        <h1>健康记录</h1>
      </div>
      <button v-if="canCreate" class="button primary" @click="openForm()">
        <Plus :size="18" />新增记录
      </button>
    </div>
    <div v-if="!visible" class="empty-state">
      <Activity :size="36" />
      <h3>暂无查看权限</h3>
      <p>该成员尚未授权你查看健康记录。</p>
    </div>
    <template v-else>
      <div class="toolbar">
        <div class="segmented">
          <button :class="{ active: tab === 'records' }" @click="tab = 'records'">
            <List :size="16" />记录</button
          ><button :class="{ active: tab === 'trend' }" @click="tab = 'trend'">
            <ChartNoAxesCombined :size="16" />趋势
          </button>
        </div>
        <div class="date-filter">
          <CalendarDays :size="16" /><input
            v-model="fromDate"
            type="date"
            aria-label="开始日期"
          /><span>至</span
          ><input v-model="toDate" type="date" :min="fromDate" aria-label="结束日期" />
        </div>
        <label class="inline-check"><input v-model="deleted" type="checkbox" />已删除</label>
      </div>
      <div v-if="tab === 'trend'" class="trend-section">
        <div class="section-heading compact">
          <h2>测量趋势</h2>
          <select v-model="metric" aria-label="趋势指标">
            <option value="pressure">血压 · mmHg</option>
            <option value="pulse">心率 · bpm</option>
            <option value="oxygen">血氧 · %</option>
            <option value="temperature">体温 · °C</option>
          </select>
        </div>
        <TrendChart :records="records" :metric="metric" />
      </div>
      <div v-else-if="!records.length" class="empty-state">
        <Activity :size="36" />
        <h3>{{ deleted ? '没有已删除记录' : '还没有测量记录' }}</h3>
        <p>
          {{
            fromDate || toDate ? '所选日期范围内没有记录。' : '每一次测量，都为家人多留一份安心。'
          }}
        </p>
        <button v-if="canCreate && !deleted" class="button secondary" @click="openForm()">
          <Plus :size="16" />记录第一次测量
        </button>
      </div>
      <div v-else class="record-list">
        <article v-for="record in records" :key="record.id" class="record-row">
          <div class="record-date">
            <strong>{{ record.measuredAt.slice(5, 10).replace('-', ' / ') }}</strong
            ><span>{{ record.measuredAt.slice(11, 16) }}</span>
          </div>
          <div class="record-values">
            <div v-if="record.systolic !== null" class="record-reading">
              <strong
                >{{ record.systolic }}<span class="reading-slash">/</span
                >{{ record.diastolic }}</strong
              ><span>血压 mmHg</span>
            </div>
            <div v-if="record.pulse !== null" class="record-reading">
              <strong>{{ record.pulse }}</strong
              ><span>心率 bpm</span>
            </div>
            <div v-if="record.oxygen !== null" class="record-reading">
              <strong>{{ record.oxygen }}</strong
              ><span>血氧 %</span>
            </div>
            <div v-if="record.temperature !== null" class="record-reading">
              <strong>{{ record.temperature }}</strong
              ><span>体温 °C</span>
            </div>
          </div>
          <div class="record-meta">
            <span>{{ labels.posture[record.posture] }} · {{ labels.arm[record.arm] }}</span
            ><span>{{ ownerName(record.recordedBy) }} 录入</span>
            <p v-if="record.note">{{ record.note }}</p>
          </div>
          <div class="row-actions">
            <button
              class="icon-button"
              :disabled="!state.online"
              title="记录历史"
              aria-label="记录历史"
              @click="historyFor(record)"
            >
              <History :size="17" /></button
            ><template v-if="state.session && canEditOwned(state.session.user, record.ownerId)"
              ><button
                v-if="!deleted"
                class="icon-button"
                title="编辑记录"
                aria-label="编辑记录"
                @click="openForm(record)"
              >
                <Pencil :size="17" /></button
              ><button
                v-if="!deleted"
                class="icon-button danger"
                title="删除记录"
                aria-label="删除记录"
                @click="pendingAction = { record, restore: false }"
              >
                <Trash2 :size="17" /></button
              ><button
                v-else
                class="icon-button"
                title="恢复记录"
                aria-label="恢复记录"
                @click="pendingAction = { record, restore: true }"
              >
                <RotateCcw :size="17" /></button
            ></template>
          </div>
        </article>
      </div>
      <p class="page-footnote">{{ records.length }} 条记录 · 北京时间 GMT+8</p>
    </template>
    <HealthForm
      v-if="formOpen"
      :record="editing"
      :owner-id="ownerId"
      :members="writableMembers"
      @close="formOpen = false"
    />
    <ModalDialog
      v-if="pendingAction"
      :title="pendingAction.restore ? '恢复记录' : '删除记录'"
      @close="pendingAction = undefined"
      ><p class="modal-description">
        {{
          pendingAction.restore
            ? '将恢复此条测量记录。'
            : '记录移入已删除列表，原始内容和修改历史仍会保留。'
        }}
      </p>
      <footer class="modal-actions">
        <button class="button secondary" @click="pendingAction = undefined">取消</button
        ><button
          :class="['button', pendingAction.restore ? 'primary' : 'danger-button']"
          :disabled="busy"
          @click="confirmAction"
        >
          确认{{ pendingAction.restore ? '恢复' : '删除' }}
        </button>
      </footer></ModalDialog
    >
    <ModalDialog v-if="historyRecord" title="记录历史" @close="historyRecord = undefined"
      ><p v-if="historyError" class="form-error">{{ historyError }}</p>
      <p v-else-if="!revisions.length" class="muted">暂无历史版本</p>
      <div v-for="revision in revisions" :key="revision.id" class="history-row">
        <strong>版本 {{ revision.version }}</strong
        ><span>{{ displayTime(revision.createdAt) }} · {{ ownerName(revision.actorId) }}</span>
        <div class="muted">
          {{ revision.data.systolic ?? '—' }} / {{ revision.data.diastolic ?? '—' }} mmHg ·
          {{ revision.data.pulse ?? '—' }} bpm · {{ revision.data.oxygen ?? '—' }}% ·
          {{ revision.data.temperature ?? '—' }}°C
        </div>
        <p v-if="revision.data.note">{{ revision.data.note }}</p>
      </div></ModalDialog
    >
  </section>
</template>
