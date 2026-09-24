<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  DatabaseBackup,
  Download,
  FileJson,
  FileSpreadsheet,
  FolderOpen,
  LoaderCircle,
  ShieldCheck,
  Upload,
} from 'lucide-vue-next';
import {
  beijingDate,
  beijingNow,
  csvCell,
  decryptBackup,
  encryptBackup,
  type BackupData,
  type BackupEnvelope,
  type HealthRecord,
  type Medication,
} from '@simcare/shared';
import { state, logoutLocal, syncNow } from '../sync';
import { api, displayTime, downloadFile, errorMessage, notify } from '../state/client';
import ModalDialog from '../components/ModalDialog.vue';
interface Preview {
  previewId: string;
  summary: {
    mode: string;
    sourceId: string;
    createdAt: string;
    users: number;
    healthRecords: number;
    medications: number;
    importRows: number;
    conflictCount: number;
  };
  conflicts: { table: string; id: string; reason: string }[];
  expiresAt: string;
}
const systemAdmin = computed(() => state.session?.user.systemRole === 'system_admin');
const admin = computed(() => state.session?.user.householdRole === 'admin');
const exportScope = ref<'personal' | 'family'>('personal');
const password = ref('');
const importPassword = ref('');
const restoreMode = ref<'merge' | 'overwrite'>('merge');
const restoreFile = ref<File>();
const preview = ref<Preview>();
const confirming = ref(false);
const busy = ref(false);
const error = ref('');
const onlineReady = computed(() => state.online && state.pendingCount === 0);
async function exportRecords(format: 'json' | 'csv') {
  busy.value = true;
  error.value = '';
  try {
    await syncNow();
    if (state.error) throw new Error(state.error);
    const ownerId = exportScope.value === 'personal' ? state.session?.user.id : null;
    const healthRecords = (state.snapshot?.healthRecords ?? []).filter(
      (item) => !ownerId || item.ownerId === ownerId,
    );
    const medications = (state.snapshot?.medications ?? []).filter(
      (item) => !ownerId || item.ownerId === ownerId,
    );
    const filename = `simcare-${exportScope.value}-${beijingDate()}`;
    if (format === 'json')
      downloadFile(
        `${filename}.json`,
        JSON.stringify(
          { exportedAt: beijingNow(), scope: exportScope.value, healthRecords, medications },
          null,
          2,
        ),
      );
    else {
      const ownerName = (id: string) =>
        state.snapshot?.members.find((member) => member.id === id)?.nickname ?? id;
      const headers = [
        '记录类型',
        '成员',
        '测量时间或开始日期',
        '收缩压',
        '舒张压',
        '心率',
        '血氧',
        '体温',
        '药品名称',
        '规格',
        '计划',
        '备注',
        '删除时间',
      ];
      const healthRows = healthRecords.map((record: HealthRecord) => [
        '健康记录',
        ownerName(record.ownerId),
        record.measuredAt,
        record.systolic,
        record.diastolic,
        record.pulse,
        record.oxygen,
        record.temperature,
        '',
        '',
        '',
        record.note,
        record.deletedAt,
      ]);
      const medicationRows = medications.map((item: Medication) => [
        '用药计划',
        ownerName(item.ownerId),
        item.startDate,
        '',
        '',
        '',
        '',
        '',
        item.name,
        item.specification,
        JSON.stringify(item.schedules),
        item.note,
        item.deletedAt,
      ]);
      downloadFile(
        `${filename}.csv`,
        '\uFEFF' +
          [headers, ...healthRows, ...medicationRows]
            .map((row) => row.map(csvCell).join(','))
            .join('\r\n'),
        'text/csv;charset=utf-8',
      );
    }
    notify('数据导出完成');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
async function exportBackup() {
  busy.value = true;
  error.value = '';
  try {
    const data = await api<BackupData>('/backups/export');
    const encrypted = await encryptBackup(data, password.value);
    downloadFile(`simcare-backup-${beijingDate()}.simcare`, JSON.stringify(encrypted));
    password.value = '';
    notify('加密备份已生成');
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
function chooseFile(event: Event) {
  restoreFile.value = (event.target as HTMLInputElement).files?.[0];
  preview.value = undefined;
}
async function previewRestore() {
  if (!restoreFile.value) return;
  const file = restoreFile.value;
  const mode = restoreMode.value;
  busy.value = true;
  error.value = '';
  preview.value = undefined;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('备份文件超过 25 MB，请联系系统维护者');
    const envelope = JSON.parse(await file.text()) as BackupEnvelope;
    const backup = await decryptBackup(envelope, importPassword.value);
    const result = await api<Preview>('/backups/preview', 'POST', {
      backup,
      mode,
    });
    if (file !== restoreFile.value || mode !== restoreMode.value)
      throw new Error('文件或恢复方式已变化，请重新校验');
    preview.value = result;
    importPassword.value = '';
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
async function restore() {
  if (!preview.value) return;
  if (preview.value.summary.mode !== restoreMode.value) {
    error.value = '恢复方式已变化，请重新校验';
    confirming.value = false;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api('/backups/restore', 'POST', { previewId: preview.value.previewId });
    confirming.value = false;
    await logoutLocal();
    notify('恢复成功，请重新登录');
  } catch (reason) {
    error.value = errorMessage(reason);
    confirming.value = false;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="page-section settings-page">
    <div class="section-heading">
      <div>
        <p class="eyebrow">数据管理</p>
        <h1>数据与备份</h1>
      </div>
      <DatabaseBackup :size="28" class="muted" />
    </div>
    <div v-if="!onlineReady" class="inline-banner warning">
      {{ !state.online ? '请联网后导出或恢复数据。' : '仍有待同步记录，请完成同步后再进行备份。' }}
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <section class="settings-section">
      <div class="section-heading compact">
        <h2>记录导出</h2>
        <select v-model="exportScope" aria-label="导出范围">
          <option value="personal">我的记录</option>
          <option v-if="admin" value="family">全家记录</option>
        </select>
      </div>
      <div class="export-actions">
        <button
          class="button secondary"
          :disabled="busy || !onlineReady"
          @click="exportRecords('json')"
        >
          <FileJson :size="19" />导出 JSON</button
        ><button
          class="button secondary"
          :disabled="busy || !onlineReady"
          @click="exportRecords('csv')"
        >
          <FileSpreadsheet :size="19" />导出 CSV
        </button>
      </div>
    </section>
    <template v-if="systemAdmin"
      ><section class="settings-section">
        <div class="section-heading compact">
          <div>
            <h2>完整系统备份</h2>
            <p class="muted">家庭、成员、授权、健康记录、用药及凭据元数据</p>
          </div>
          <ShieldCheck :size="21" />
        </div>
        <form class="inline-form" @submit.prevent="exportBackup">
          <label
            >备份密码<input
              v-model="password"
              type="password"
              minlength="12"
              autocomplete="new-password"
              required
              placeholder="至少 12 个字符" /></label
          ><button class="button primary" :disabled="busy || !onlineReady">
            <LoaderCircle v-if="busy" class="spin" :size="17" /><Download
              v-else
              :size="17"
            />下载加密备份
          </button>
        </form>
      </section>
      <section class="settings-section">
        <div class="section-heading compact">
          <h2>恢复系统数据</h2>
          <Upload :size="21" class="muted" />
        </div>
        <form class="form-stack" @submit.prevent="previewRestore">
          <label class="file-picker"
            ><FolderOpen :size="23" /><span>{{
              restoreFile?.name ?? '选择 .simcare 备份文件'
            }}</span
            ><input type="file" accept=".simcare,.json" required @change="chooseFile"
          /></label>
          <div class="form-grid">
            <label
              >备份密码<input
                v-model="importPassword"
                type="password"
                autocomplete="off"
                required /></label
            ><label
              >恢复方式<select v-model="restoreMode" @change="preview = undefined">
                <option value="merge">合并到当前系统</option>
                <option value="overwrite">覆盖当前系统</option>
              </select></label
            >
          </div>
          <button class="button secondary align-start" :disabled="busy || !onlineReady">
            <LoaderCircle v-if="busy" class="spin" :size="17" /><Upload
              v-else
              :size="17"
            />校验并预览
          </button>
        </form>
        <div v-if="preview" class="restore-preview">
          <h3>恢复预览</h3>
          <dl class="detail-list">
            <div>
              <dt>备份时间</dt>
              <dd>{{ displayTime(preview.summary.createdAt) }}</dd>
            </div>
            <div>
              <dt>成员</dt>
              <dd>{{ preview.summary.users }} 位</dd>
            </div>
            <div>
              <dt>健康记录</dt>
              <dd>{{ preview.summary.healthRecords }} 条</dd>
            </div>
            <div>
              <dt>药品</dt>
              <dd>{{ preview.summary.medications }} 种</dd>
            </div>
            <div>
              <dt>冲突</dt>
              <dd>{{ preview.summary.conflictCount }} 项</dd>
            </div>
          </dl>
          <details v-if="preview.conflicts.length">
            <summary>查看冲突</summary>
            <div v-for="(conflict, index) in preview.conflicts" :key="index" class="history-row">
              <strong>{{ conflict.table }}</strong>
              <p>{{ conflict.reason }}</p>
            </div>
          </details>
          <button
            class="button danger-button"
            :disabled="busy || !onlineReady"
            @click="confirming = true"
          >
            {{ restoreMode === 'overwrite' ? '确认覆盖恢复' : '确认合并恢复' }}
          </button>
        </div>
      </section></template
    >
    <ModalDialog v-if="confirming" title="最后确认" @close="confirming = false"
      ><p class="modal-description">
        {{
          restoreMode === 'overwrite'
            ? '当前业务数据将被此备份替换。'
            : '将导入可合并的数据，冲突项保留当前数据。'
        }}恢复完成后，所有设备需要重新登录。
      </p>
      <footer class="modal-actions">
        <button class="button secondary" @click="confirming = false">取消</button
        ><button class="button danger-button" :disabled="busy" @click="restore">执行恢复</button>
      </footer></ModalDialog
    >
  </section>
</template>
