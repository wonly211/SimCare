<script setup lang="ts">
import { computed } from 'vue';
import { labels } from '@simcare/shared';
import type { StoredRecord } from '../storage/database';
import { state } from '../sync';
import { displayTime } from '../state/client';
const props = defineProps<{ record?: StoredRecord | null }>();
const memberName = (id: string) =>
  state.snapshot?.members.find((member) => member.id === id)?.nickname ?? '家庭成员';
const fields = computed(() => {
  const r = props.record;
  if (!r) return [];
  const values: [string, string][] = [['所属成员', memberName(r.ownerId)]];
  if ('systolic' in r) {
    values.push(
      ['测量时间', displayTime(r.measuredAt)],
      ['高压 / 低压', r.systolic === null ? '未填写' : `${r.systolic} / ${r.diastolic} mmHg`],
      ['心率', r.pulse === null ? '未填写' : `${r.pulse} 次/分`],
      ['血氧', r.oxygen === null ? '未填写' : `${r.oxygen}%`],
      ['体温', r.temperature === null ? '未填写' : `${r.temperature} ℃`],
      ['测量姿势', labels.posture[r.posture]],
      ['测量手臂', labels.arm[r.arm]],
      ['录入人', memberName(r.recordedBy)],
    );
  } else {
    values.push(
      ['药品', r.name],
      ['规格', r.specification || '未填写'],
      ['剂型 / 用法', `${r.form} / ${r.route}`],
      ['状态', labels.status[r.status]],
      ['用药原因', r.reason || '未填写'],
      ['起止日期', `${r.startDate} 至 ${r.endDate || '未设结束日期'}`],
    );
    r.schedules.forEach((s, i) =>
      values.push([
        `安排 ${i + 1}`,
        `${s.time || labels.period[s.period]} · 每次 ${s.dose} ${s.unit} · ${labels.meal[s.meal]} · ${s.weekdays.map((d) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d]).join('、')}`,
      ]),
    );
  }
  values.push(
    ['备注', r.note || '未填写'],
    ['最近修改', displayTime(r.updatedAt)],
    ['修改人', memberName(r.updatedBy)],
    ['记录状态', r.deletedAt ? '已删除' : '保留中'],
  );
  return values;
});
</script>
<template>
  <dl v-if="record" class="readable-fields">
    <div v-for="[label, value] in fields" :key="label">
      <dt>{{ label }}</dt>
      <dd>{{ value }}</dd>
    </div>
  </dl>
  <p v-else>当前没有可查看的记录。</p>
</template>
