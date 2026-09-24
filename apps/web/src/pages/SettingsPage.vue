<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import type { Device, LoginRequest } from '@simcare/shared';
import { state, syncNow, logoutLocal } from '../sync';
import { api, displayTime, errorMessage, notify } from '../state/client';
import ModalDialog from '../components/ModalDialog.vue';
const devices = ref<Device[]>([]),
  requests = ref<LoginRequest[]>([]),
  nickname = ref(state.session?.user.nickname ?? ''),
  busy = ref(false),
  removing = ref<Device | null>(null);
const online = computed(() => state.online),
  admin = computed(() => state.session?.user.householdRole === 'admin');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function load() {
  if (!online.value) return;
  try {
    devices.value = await api<Device[]>('/auth/devices');
    if (admin.value) requests.value = await api<LoginRequest[]>('/auth/requests');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  }
}
async function refresh() {
  await load();
  if (!disposed) timer = setTimeout(refresh, 10000);
}
async function rename() {
  try {
    await api(`/members/${state.session!.user.id}`, 'PATCH', { nickname: nickname.value });
    await syncNow();
    notify('昵称已更新');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  }
}
async function decide(request: LoginRequest, approve: boolean) {
  busy.value = true;
  try {
    await api(`/auth/requests/${request.id}/decision`, 'POST', { approve });
    await load();
    await syncNow();
    notify(approve ? '已批准设备登录' : '已拒绝申请');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!removing.value) return;
  busy.value = true;
  try {
    const current = removing.value.current;
    await api(`/auth/devices/${removing.value.id}`, 'DELETE');
    removing.value = null;
    if (current) await logoutLocal();
    else await load();
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  } finally {
    busy.value = false;
  }
}
onMounted(() => void refresh());
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<template>
  <section class="page-section settings-page">
    <div class="section-heading"><h1>我的账户</h1></div>
    <section class="settings-section">
      <h2>个人资料</h2>
      <p>手机号：{{ state.session?.user.phone }}</p>
      <form class="inline-form" @submit.prevent="rename">
        <label>姓名或昵称<input v-model="nickname" required maxlength="80" /></label
        ><button class="button secondary" :disabled="!online">保存</button>
      </form>
    </section>
    <section v-if="admin" class="settings-section">
      <div class="section-heading compact">
        <h2>登录申请</h2>
        <button class="button secondary" :disabled="!online" @click="load">刷新</button>
      </div>
      <p class="muted">请核对家人的手机号与设备名称，再批准登录。申请 10 分钟有效。</p>
      <p v-if="!requests.length">暂无待批准申请</p>
      <article v-for="request in requests" :key="request.id" class="credential-row">
        <div>
          <strong>{{ request.nickname || request.phone }} · {{ request.phone }}</strong>
          <p>
            {{ request.deviceName }} · {{ request.newMember ? '新成员' : '已有成员' }} ·
            {{ displayTime(request.expiresAt) }} 过期
          </p>
        </div>
        <button class="button primary" :disabled="busy || !online" @click="decide(request, true)">
          批准</button
        ><button
          class="button secondary"
          :disabled="busy || !online"
          @click="decide(request, false)"
        >
          拒绝
        </button>
      </article>
    </section>
    <section class="settings-section">
      <h2>已登录设备</h2>
      <p class="muted">联网使用时自动延长登录，有效期最长为最后使用后的 180 天。</p>
      <article v-for="device in devices" :key="device.id" class="credential-row">
        <div>
          <strong>{{ device.name }}{{ device.current ? '（当前设备）' : '' }}</strong>
          <p>最近使用 {{ displayTime(device.lastUsedAt) }}</p>
        </div>
        <button class="button secondary" :disabled="!online" @click="removing = device">
          移除
        </button>
      </article>
    </section>
    <ModalDialog v-if="removing" title="移除设备" @close="removing = null"
      ><p>移除“{{ removing.name }}”后，该设备需要重新申请登录。</p>
      <button class="button primary" :disabled="busy" @click="remove">确认移除</button></ModalDialog
    >
  </section>
</template>
