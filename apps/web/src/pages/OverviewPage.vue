<script setup lang="ts">
import { computed, ref } from 'vue';
import { Plus, Pill } from 'lucide-vue-next';
import { canCreateHealth, canViewHealth, todayMedication, labels } from '@simcare/shared';
import { state } from '../sync';
import { displayTime, today } from '../state/client';
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
const latest = computed(() =>
  visible.value
    ? (state.snapshot?.healthRecords ?? [])
        .filter((record) => record.ownerId === props.ownerId && !record.deletedAt)
        .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0]
    : undefined,
);
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
  <section class="page-section readable-overview">
    <h1>
      {{
        ownerId === state.session?.user.id
          ? '我的健康概览'
          : `${owner?.nickname ?? '成员'}的健康概览`
      }}
    </h1>
    <div class="overview-readable-grid">
      <section class="daily-section">
        <div class="section-heading"><h2>今天的用药</h2></div>
        <p class="muted">{{ today }} · {{ doses.length }} 项计划安排</p>
        <div v-if="!doses.length" class="readable-card small-empty">
          <Pill :size="28" />
          <p>今天暂无用药安排</p>
        </div>
        <article
          v-for="dose in doses.slice(0, 2)"
          :key="`${dose.medication.id}-${dose.schedule.id}`"
          class="readable-card medicine-card"
        >
          <p class="dose-period">
            {{ dose.schedule.time || labels.period[dose.schedule.period] }} ·
            {{ labels.meal[dose.schedule.meal] }}
          </p>
          <h3>{{ dose.medication.name }}</h3>
          <p class="dose-readable">每次 {{ dose.schedule.dose }} {{ dose.schedule.unit }}</p>
          <p v-if="dose.medication.specification" class="muted">
            {{ dose.medication.specification }}
          </p>
        </article>
        <button class="button primary full-width" @click="emit('navigate', 'medication')">
          查看今天全部用药安排
        </button>
        <p class="page-footnote">这里只显示计划，不代表已经服药。</p>
      </section>
      <section class="daily-section">
        <div class="section-heading"><h2>最近一次测量</h2></div>
        <article v-if="latest" class="readable-card latest-measurement">
          <p class="muted">{{ displayTime(latest.measuredAt) }} · 北京时间</p>
          <template v-if="latest.systolic !== null"
            ><h3>血压</h3>
            <p class="large-reading">
              {{ latest.systolic }} / {{ latest.diastolic }} <span>mmHg</span>
            </p>
            <p>高压 {{ latest.systolic }} · 低压 {{ latest.diastolic }}</p></template
          >
          <p v-if="latest.pulse !== null">
            心率 <strong>{{ latest.pulse }}</strong> 次/分
          </p>
          <p v-if="latest.oxygen !== null">
            血氧 <strong>{{ latest.oxygen }}</strong> %
          </p>
          <p v-if="latest.temperature !== null">
            体温 <strong>{{ latest.temperature }}</strong> ℃
          </p>
          <p v-if="latest.note">{{ latest.note }}</p>
        </article>
        <div v-else class="readable-card">
          <p>{{ visible ? '还没有测量记录' : '该成员尚未授权查看健康记录' }}</p>
        </div>
        <button class="button secondary full-width" @click="emit('navigate', 'health')">
          查看以前的记录
        </button>
        <button
          v-if="canCreate"
          class="button secondary full-width record-entry"
          @click="showForm = true"
        >
          <Plus :size="20" />为{{ owner?.nickname }}记录测量
        </button>
      </section>
    </div>
    <HealthForm
      v-if="showForm"
      :owner-id="ownerId"
      :members="writableMembers"
      @close="showForm = false"
    />
  </section>
</template>
