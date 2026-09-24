<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { Activity, LoaderCircle } from 'lucide-vue-next';
import type { LoginTicket, Session } from '@simcare/shared';
import TextSizeControl from '../components/TextSizeControl.vue';
import { acceptSession } from '../sync';
import { api, errorMessage } from '../state/client';
const initialized = ref<boolean | null>(null),
  configured = ref(true),
  phone = ref(''),
  nickname = ref(''),
  initKey = ref(''),
  deviceName = ref('我的设备');
const adminLogin = ref(false),
  busy = ref(false),
  error = ref(''),
  ticket = ref<LoginTicket | null>(null);
const inviteToken = new URLSearchParams(location.search).get('invite') ?? undefined;
const title = computed(() =>
  initialized.value === false
    ? '建立你的家庭记录'
    : adminLogin.value
      ? '系统管理员登录'
      : inviteToken
        ? '加入家庭'
        : '手机号登录',
);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
function cancel() {
  ticket.value = null;
  clearTimeout(timer);
}
async function finish(session: Session) {
  history.replaceState(history.state, '', location.pathname + location.hash);
  await acceptSession(session);
}
async function poll() {
  if (!ticket.value || disposed) return;
  try {
    const result = await api<{ status: string; session?: Session }>(
      `/auth/requests/${ticket.value.id}/poll`,
      'POST',
      { pollToken: ticket.value.pollToken },
    );
    if (result.status === 'approved' && result.session) {
      ticket.value = null;
      await finish(result.session);
      return;
    }
    if (result.status !== 'pending') {
      error.value =
        result.status === 'expired'
          ? '申请已过期，请重新申请'
          : result.status === 'rejected'
            ? '管理员未批准，可联系管理员后重试'
            : '申请已领取，请重新申请';
      ticket.value = null;
      return;
    }
  } catch (reason) {
    error.value = errorMessage(reason);
    if (Date.parse(ticket.value?.expiresAt ?? '') <= Date.now()) {
      ticket.value = null;
      return;
    }
  }
  if (!disposed && ticket.value) timer = setTimeout(poll, 3000);
}
async function submit() {
  busy.value = true;
  error.value = '';
  try {
    if (!initialized.value || adminLogin.value)
      await finish(
        await api<Session>(initialized.value ? '/auth/admin-recover' : '/auth/initialize', 'POST', {
          phone: phone.value,
          initKey: initKey.value,
          deviceName: deviceName.value,
          ...(!initialized.value ? { nickname: nickname.value } : {}),
        }),
      );
    else {
      ticket.value = await api<LoginTicket>('/auth/requests', 'POST', {
        phone: phone.value,
        deviceName: deviceName.value,
        ...(inviteToken ? { inviteToken, nickname: nickname.value } : {}),
      });
      void poll();
    }
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    const status = await api<{ initialized: boolean; configured: boolean }>('/auth/status');
    initialized.value = status.initialized;
    configured.value = status.configured;
  } catch (reason) {
    error.value = errorMessage(reason);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<template>
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-brand"><Activity :size="30" /><strong>简护 | Simcare</strong></div>
      <p class="eyebrow">家庭健康记录</p>
      <TextSizeControl />
      <h1>{{ title }}</h1>
      <p v-if="!configured" class="error-message" role="alert">
        请先在 Cloudflare Worker 设置中添加普通变量 init_key 并保存。
      </p>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      <div v-if="ticket" class="form-stack">
        <h2>等待管理员批准</h2>
        <p>请让管理员打开“我的 → 登录申请”，确认手机号 {{ phone }} 和设备名称。</p>
        <p>申请 10 分钟有效，请保持此页面打开。</p>
        <button class="button secondary" @click="cancel">返回</button>
      </div>
      <form v-else-if="initialized !== null" class="form-stack" @submit.prevent="submit">
        <label
          >手机号<input
            v-model="phone"
            type="tel"
            autocomplete="tel"
            required
            placeholder="11 位手机号"
            maxlength="20"
        /></label>
        <label v-if="!initialized || (inviteToken && !adminLogin)"
          >姓名或昵称<input v-model="nickname" required maxlength="80" autocomplete="name"
        /></label>
        <label
          >设备名称<input
            v-model="deviceName"
            required
            maxlength="80"
            placeholder="例如：妈妈的手机"
        /></label>
        <label v-if="!initialized || adminLogin"
          >初始化密钥<input
            v-model="initKey"
            type="password"
            required
            autocomplete="off"
            placeholder="Worker 设置中的 init_key"
        /></label>
        <button
          class="button primary"
          :disabled="busy || ((!initialized || adminLogin) && !configured)"
        >
          <LoaderCircle v-if="busy" :size="18" />{{
            !initialized ? '建立家庭' : adminLogin ? '登录' : '申请登录'
          }}
        </button>
        <button
          v-if="initialized"
          type="button"
          class="text-button"
          @click="
            adminLogin = !adminLogin;
            error = '';
          "
        >
          {{ adminLogin ? '返回成员登录' : '系统管理员登录' }}
        </button>
        <p class="muted">不收短信，需要家人批准一次。批准后，这台设备会保持登录。</p>
      </form>
    </section>
  </main>
</template>
<style scoped>
.auth-shell {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 16px;
  background: #f4f7f8;
}
.auth-card {
  width: min(100%, 440px);
  padding: clamp(16px, 4vw, 32px);
  background: white;
  border-radius: 24px;
  box-shadow: 0 12px 48px #164e3610;
}
.auth-brand {
  display: flex;
  gap: 12px;
  align-items: center;
  color: #087f72;
  font-size: 1.2rem;
}
.error-message {
  color: #ac2525;
  padding: 12px;
  background: #fff1f1;
  border-radius: 10px;
}
</style>
