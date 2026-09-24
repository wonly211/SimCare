<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { HealthRecord } from '@simcare/shared';
echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);
const props = withDefaults(
  defineProps<{
    records: HealthRecord[];
    metric?: 'pressure' | 'pulse' | 'oxygen' | 'temperature';
  }>(),
  { metric: 'pressure' },
);
const element = ref<HTMLElement>();
let chart: echarts.ECharts | undefined;
let observer: ResizeObserver | undefined;
const sorted = computed(() =>
  [...props.records]
    .filter((record) => !record.deletedAt)
    .sort((left, right) => left.measuredAt.localeCompare(right.measuredAt)),
);
const hasData = computed(() =>
  sorted.value.some((record) =>
    props.metric === 'pressure' ? record.systolic !== null : record[props.metric] !== null,
  ),
);
function render() {
  if (!element.value || !chart) return;
  const fields =
    props.metric === 'pressure'
      ? [
          { key: 'systolic', name: '收缩压', color: '#19766b' },
          { key: 'diastolic', name: '舒张压', color: '#a8576c' },
        ]
      : [
          {
            key: props.metric,
            name: { pulse: '心率', oxygen: '血氧', temperature: '体温' }[props.metric],
            color: '#19766b',
          },
        ];
  chart.setOption(
    {
      animationDuration: 350,
      grid: { left: 46, right: 18, top: 20, bottom: 50 },
      tooltip: { trigger: 'axis', confine: true },
      legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: '#64726c' } },
      xAxis: {
        type: 'category',
        data: sorted.value.map(
          (record) => `${record.measuredAt.slice(5, 10)} ${record.measuredAt.slice(11, 16)}`,
        ),
        axisLine: { lineStyle: { color: '#dde4df' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#738078',
          hideOverlap: true,
          formatter: (value: string) => value.split(' ')[0],
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitNumber: 4,
        axisLabel: { color: '#738078' },
        splitLine: { lineStyle: { color: '#ecf0ed', type: 'dashed' } },
      },
      series: fields.map((field) => ({
        name: field.name,
        type: 'line',
        smooth: false,
        symbolSize: 7,
        connectNulls: false,
        data: sorted.value.map(
          (record) =>
            record[field.key as 'systolic' | 'diastolic' | 'pulse' | 'oxygen' | 'temperature'],
        ),
        itemStyle: { color: field.color },
        lineStyle: { width: 2 },
        emphasis: { focus: 'series' },
      })),
    },
    true,
  );
}
onMounted(() => {
  if (!element.value) return;
  chart = echarts.init(element.value);
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(element.value);
  render();
});
watch(() => [props.records, props.metric], render, { deep: true });
onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
</script>
<template>
  <div class="chart-wrap">
    <div
      ref="element"
      class="trend-chart"
      role="img"
      :aria-label="metric === 'pressure' ? '血压趋势图' : '测量趋势图'"
    />
    <div v-if="!hasData" class="chart-empty">暂无该指标的测量数据</div>
  </div>
</template>
