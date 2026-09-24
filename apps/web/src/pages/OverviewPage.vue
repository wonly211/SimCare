<script setup lang="ts">
import { computed, ref } from 'vue';
import { Activity, ArrowRight, Droplets, Heart, Pill, Plus, Thermometer } from 'lucide-vue-next';
import { canCreateHealth, canViewHealth, todayMedication, labels } from '@simcare/shared';
import { state } from '../sync';
import { displayTime, today } from '../state/client';
import TrendChart from '../components/TrendChart.vue';
import HealthForm from '../components/HealthForm.vue';
const props = defineProps<{ ownerId: string }>();
const emit = defineEmits<{ navigate: [page: string] }>();
const showForm = ref(false);
const owner = computed(() => state.snapshot?.members.find((member) => member.id === props.ownerId));
const visible = computed(
  () =>
    !!state.session &&
    canViewHealth(state.session.user, props.ownerId, state.snapshot?.grants ?? []),
);
const records = computed(() =>
  visible.value
    ? (state.snapshot?.healthRecords ?? [])
        .filter((record) => record.ownerId === props.ownerId && !record.deletedAt)
        .sort((left, right) => right.measuredAt.localeCompare(left.measuredAt))
    : [],
);
const recent = computed(() => records.value.slice(0, 3));
const bloodPressure = computed(() => records.value.find((record) => record.systolic !== null));
const pulse = computed(() => records.value.find((record) => record.pulse !== null));
const oxygen = computed(() => records.value.find((record) => record.oxygen !== null));
const temperature = computed(() => records.value.find((record) => record.temperature !== null));
const doses = computed(() =>
  todayMedication(
    (state.snapshot?.medications ?? []).filter((item) => item.ownerId === props.ownerId),
    today.value,
  ),
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
</script>
<template>
  <section class="page-section">
    <div class="section-heading">
      <div>
        <p class="eyebrow">家庭健康档案</p>
        <h1>
          {{
            ownerId === state.session?.user.id
              ? '我的健康概览'
              : `${owner?.nickname ?? '成员'}的健康概览`
          }}
        </h1>
        <p class="section-subtitle">最近测量与今日用药</p>
      </div>
      <button v-if="canCreate" class="button primary" @click="showForm = true">
        <Plus :size="18" />新增健康记录
      </button>
    </div>
    <div class="metric-grid">
      <article class="metric-card">
        <div class="metric-heading"><span>血压</span><Activity :size="19" /></div>
        <div class="metric-value">
          {{ bloodPressure?.systolic ?? '—' }}<span class="metric-divider">/</span
          >{{ bloodPressure?.diastolic ?? '—' }}
        </div>
        <div class="metric-bottom">
          <span>mmHg</span><time>{{ displayTime(bloodPressure?.measuredAt) }}</time>
        </div>
      </article>
      <article class="metric-card rose">
        <div class="metric-heading"><span>心率</span><Heart :size="19" /></div>
        <div class="metric-value">{{ pulse?.pulse ?? '—' }}</div>
        <div class="metric-bottom">
          <span>bpm</span><time>{{ displayTime(pulse?.measuredAt) }}</time>
        </div>
      </article>
      <article class="metric-card blue">
        <div class="metric-heading"><span>血氧</span><Droplets :size="19" /></div>
        <div class="metric-value">{{ oxygen?.oxygen ?? '—' }}</div>
        <div class="metric-bottom">
          <span>%</span><time>{{ displayTime(oxygen?.measuredAt) }}</time>
        </div>
      </article>
      <article class="metric-card gold">
        <div class="metric-heading"><span>体温</span><Thermometer :size="19" /></div>
        <div class="metric-value">{{ temperature?.temperature ?? '—' }}</div>
        <div class="metric-bottom">
          <span>°C</span><time>{{ displayTime(temperature?.measuredAt) }}</time>
        </div>
      </article>
    </div>
    <div class="overview-columns">
      <section class="overview-trend">
        <div class="section-heading compact">
          <div>
            <h2>血压趋势</h2>
            <p class="muted">最近 30 条测量</p>
          </div>
          <button class="text-button" @click="emit('navigate', 'health')">
            全部记录<ArrowRight :size="16" />
          </button>
        </div>
        <TrendChart :records="records.slice(0, 30)" />
      </section>
      <section class="overview-medications">
        <div class="section-heading compact">
          <h2>今日用药</h2>
          <button class="text-button" @click="emit('navigate', 'medication')">
            <ArrowRight :size="17" /><span class="sr-only">全部用药</span>
          </button>
        </div>
        <div v-if="!doses.length" class="small-empty">
          <Pill :size="28" />
          <p>今天暂无用药安排</p>
        </div>
        <div v-for="dose in doses.slice(0, 4)" :key="dose.schedule.id" class="mini-dose">
          <span class="mini-dose-time">{{
            dose.schedule.time || labels.period[dose.schedule.period]
          }}</span>
          <div>
            <strong>{{ dose.medication.name }}</strong
            ><span
              >{{ dose.schedule.dose }} {{ dose.schedule.unit }} ·
              {{ labels.meal[dose.schedule.meal] }}</span
            >
          </div>
        </div>
        <p class="page-footnote">{{ doses.length }} 次计划安排</p>
      </section>
    </div>
    <section class="recent-section">
      <div class="section-heading compact">
        <h2>最近记录</h2>
        <button class="text-button" @click="emit('navigate', 'health')">
          查看全部<ArrowRight :size="16" />
        </button>
      </div>
      <div v-if="!recent.length" class="small-empty horizontal">
        <Activity :size="24" />
        <p>{{ visible ? '还没有健康记录' : '此成员未授权查看健康记录' }}</p>
      </div>
      <div v-for="record in recent" :key="record.id" class="recent-row">
        <time>{{ displayTime(record.measuredAt) }}</time
        ><strong v-if="record.systolic !== null"
          >{{ record.systolic }} / {{ record.diastolic }} <small>mmHg</small></strong
        ><span v-if="record.pulse !== null">{{ record.pulse }} <small>bpm</small></span
        ><span v-if="record.oxygen !== null">{{ record.oxygen }} <small>%</small></span
        ><span v-if="record.temperature !== null">{{ record.temperature }} <small>°C</small></span>
        <p>{{ record.note || '—' }}</p>
      </div>
    </section>
    <HealthForm
      v-if="showForm"
      :owner-id="ownerId"
      :members="writableMembers"
      @close="showForm = false"
    />
  </section>
</template>
