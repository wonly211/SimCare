<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { textSize } from '../state/display';
import { displayTime } from '../state/client';
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
  const fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.9;
  chart.setOption(
    {
      animationDuration: 0,
      grid: { left: 8, right: 12, top: 24, bottom: 70, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, textStyle: { fontSize } },
      legend: {
        bottom: 0,
        icon: 'circle',
        itemWidth: 8,
        textStyle: { color: '#526960', fontSize },
      },
      xAxis: {
        type: 'category',
        data: sorted.value.map(
          (record) => `${record.measuredAt.slice(5, 10)} ${record.measuredAt.slice(11, 16)}`,
        ),
        axisLine: { lineStyle: { color: '#dde4df' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#526960',
          fontSize,
          hideOverlap: true,
          formatter: (value: string) => value.split(' ')[0],
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitNumber: 4,
        axisLabel: { color: '#526960', fontSize },
        splitLine: { lineStyle: { color: '#ecf0ed', type: 'dashed' } },
      },
      series: fields.map((field, index) => ({
        name: field.name,
        type: 'line',
        smooth: false,
        symbolSize: 9,
        symbol: index === 0 ? 'circle' : 'diamond',
        connectNulls: false,
        data: sorted.value.map(
          (record) =>
            record[field.key as 'systolic' | 'diastolic' | 'pulse' | 'oxygen' | 'temperature'],
        ),
        itemStyle: { color: field.color },
        lineStyle: { width: 3, type: index === 0 ? 'solid' : 'dashed' },
        emphasis: { focus: 'series' },
      })),
    },
    true,
  );
}
onMounted(() => {
  if (!element.value) return;
  chart = echarts.init(element.value);
  observer = new ResizeObserver(() => {
    chart?.resize();
    render();
  });
  observer.observe(element.value);
  render();
});
watch(() => [props.records, props.metric, textSize.value], render, { deep: true });
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
  <details class="trend-data">
    <summary>查看同范围测量数据</summary>
    <p>
      {{
        metric === 'pressure'
          ? '血压单位：mmHg；实线为高压，虚线为低压。'
          : metric === 'pulse'
            ? '心率单位：次/分'
            : metric === 'oxygen'
              ? '血氧单位：%'
              : '体温单位：℃'
      }}
    </p>
    <ul>
      <li v-for="record in sorted" :key="record.id">
        {{ displayTime(record.measuredAt) }}：{{
          metric === 'pressure'
            ? record.systolic === null
              ? '未测量'
              : record.systolic + ' / ' + record.diastolic
            : (record[metric] ?? '未测量')
        }}
      </li>
    </ul>
  </details>
</template>
