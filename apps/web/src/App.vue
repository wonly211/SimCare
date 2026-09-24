<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Cloud as CloudCheck,
  CloudOff,
  DatabaseBackup,
  HeartPulse,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Pill,
  RefreshCw,
  Settings,
  X,
} from 'lucide-vue-next';
import { initialize, state, syncNow, resolveConflict, logoutLocal } from './sync';
import { api, clock, errorMessage, notice, notify } from './state/client';
import AuthPage from './pages/AuthPage.vue';
import ModalDialog from './components/ModalDialog.vue';
import TextSizeControl from './components/TextSizeControl.vue';
import RecordDetails from './components/RecordDetails.vue';
import { savedMessage } from './state/client';

const loading = ref(true);
const mainContent = ref<HTMLElement>();
const router = useRouter();
const route = useRoute();
watch(
  () => route.fullPath,
  async () => {
    await nextTick();
    mainContent.value?.focus({ preventScroll: true });
  },
);
const page = computed(() => String(route.name ?? 'overview'));
const selectedMember = ref('');
const memberPickerOpen = ref(false);
const conflictOpen = ref(false);
const logoutOpen = ref(false);
const actionBusy = ref(false);
const navigation = [
  { id: 'overview', label: '首页', short: '首页', icon: LayoutDashboard },
  { id: 'health', label: '健康记录', short: '记录', icon: HeartPulse },
  { id: 'medication', label: '用药清单', short: '用药', icon: Pill },
  { id: 'settings', label: '我的账户', short: '我的', icon: Settings },
];
const members = computed(() => state.snapshot?.members.filter((member) => member.active) ?? []);
const currentLabel = computed(() =>
  page.value === 'family'
    ? '家庭成员'
    : page.value === 'backup'
      ? '数据与备份'
      : navigation.find((item) => item.id === page.value)?.label,
);
const beijingHeading = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(clock.now)),
);
function navigate(value: string) {
  void router.push({ name: value });
}
watch(
  () => state.session?.user.id,
  (id) => {
    savedMessage.value = '';
    if (id) selectedMember.value = id;
  },
);
watch(members, (list) => {
  if (list.length && !list.some((member) => member.id === selectedMember.value))
    selectedMember.value = state.session?.user.id ?? list[0]!.id;
});
async function sync() {
  try {
    await syncNow();
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  }
}
async function logout() {
  actionBusy.value = true;
  try {
    if (!state.online) throw new Error('请联网后退出，以撤销服务器会话');
    await api('/auth/logout', 'POST', {});
    await logoutLocal();
    logoutOpen.value = false;
    navigate('overview');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  } finally {
    actionBusy.value = false;
  }
}
async function resolve(id: string, choice: 'local' | 'server') {
  try {
    await resolveConflict(id, choice);
    if (!state.conflicts.length) conflictOpen.value = false;
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  }
}
onMounted(async () => {
  try {
    await initialize();
    selectedMember.value = state.session?.user.id ?? '';
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-if="loading" class="app-loading">
    <img class="brand-logo" src="/logo.png" alt="" width="48" height="48" /><strong
      >简护 | Simcare</strong
    ><LoaderCircle class="spin" :size="22" />
  </div>
  <AuthPage v-else-if="!state.session" />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#" @click.prevent="navigate('overview')"
        ><span class="brand-mark"><Activity :size="23" /></span
        ><span>简护 | Simcare<small>家庭健康记录</small></span></a
      >
      <div class="sidebar-household">
        <span class="eyebrow">我的家庭</span><strong>{{ state.session.household.name }}</strong
        ><span>{{ members.length }} 位家庭成员</span>
      </div>
      <nav class="desktop-navigation" aria-label="主导航">
        <button
          v-for="item in navigation"
          :key="item.id"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          @click="navigate(item.id)"
        >
          <component :is="item.icon" :size="20" /><span>{{ item.label }}</span
          ><span v-if="page === item.id" class="nav-indicator" />
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button
          :class="['sidebar-backup', { active: page === 'backup' }]"
          @click="navigate('backup')"
        >
          <DatabaseBackup :size="19" />数据与备份
        </button>
        <div class="sidebar-user">
          <span class="avatar">{{ state.session.user.nickname.slice(0, 1) }}</span>
          <div>
            <strong>{{ state.session.user.nickname }}</strong
            ><span>{{
              state.session.user.householdRole === 'admin' ? '家庭管理员' : '家庭成员'
            }}</span>
          </div>
          <button
            class="icon-button"
            title="退出登录"
            aria-label="退出登录"
            @click="logoutOpen = true"
          >
            <LogOut :size="17" />
          </button>
        </div>
      </div>
    </aside>
    <div class="main-layout">
      <header class="topbar">
        <span class="topbar-location">{{ currentLabel }}</span>
        <div class="topbar-right">
          <span class="topbar-date">{{ beijingHeading }}</span
          ><button
            :class="[
              'sync-status',
              { offline: !state.online, warning: state.error || state.conflicts.length },
            ]"
            :disabled="state.syncing"
            :title="state.online ? '立即同步' : '当前离线'"
            @click="state.conflicts.length ? (conflictOpen = true) : sync()"
          >
            <LoaderCircle v-if="state.syncing" class="spin" :size="16" /><CloudOff
              v-else-if="!state.online"
              :size="16"
            /><AlertCircle v-else-if="state.error || state.conflicts.length" :size="16" /><RefreshCw
              v-else-if="state.pendingCount"
              :size="16"
            /><CloudCheck v-else :size="16" /><span>{{
              state.syncing
                ? '同步中'
                : !state.online
                  ? '离线'
                  : state.conflicts.length
                    ? `${state.conflicts.length} 项待处理`
                    : state.pendingCount
                      ? `${state.pendingCount} 条待同步`
                      : state.error
                        ? '同步失败'
                        : '已同步'
            }}</span>
          </button>
        </div>
      </header>
      <main ref="mainContent" class="main-content" tabindex="-1">
        <div v-if="['overview', 'health', 'medication'].includes(page)" class="member-switch">
          <span class="member-context">当前查看</span>
          <span class="avatar small">{{
            members.find((member) => member.id === selectedMember)?.nickname.slice(0, 1) ?? '我'
          }}</span
          ><strong class="selected-member-name"
            >{{ members.find((member) => member.id === selectedMember)?.nickname
            }}{{ selectedMember === state.session?.user.id ? '（我）' : '' }}</strong
          ><button
            class="button secondary"
            aria-label="切换家庭成员"
            @click="memberPickerOpen = true"
          >
            切换</button
          ><span class="member-switch-label">这里显示当前成员的健康资料</span>
        </div>
        <div v-if="!state.online || state.pendingCount" class="inline-banner" role="status">
          <span>{{
            !state.online
              ? '当前没有网络，显示本机保存的资料。新记录会在联网后自动同步。'
              : `${state.pendingCount} 条记录已保存在本机，正在等待同步给家人。`
          }}</span>
        </div>
        <div v-if="savedMessage" class="inline-banner saved-result" role="status">
          <span>{{ savedMessage }}</span
          ><button class="text-button" @click="savedMessage = ''">知道了</button>
        </div>
        <div v-if="state.error" class="inline-banner warning">
          <AlertCircle :size="17" /><span>{{ state.error }}</span
          ><button class="text-button" @click="sync">重试</button>
        </div>
        <section v-if="page === 'settings'" class="account-shortcuts">
          <TextSizeControl /><button
            class="button secondary full-width"
            @click="navigate('family')"
          >
            家庭成员
          </button>
        </section>
        <RouterView v-slot="{ Component }">
          <component :is="Component" :owner-id="selectedMember" @navigate="navigate" />
        </RouterView>
        <div v-if="page === 'settings'" class="account-actions">
          <button class="button secondary" @click="navigate('backup')">
            <DatabaseBackup :size="18" />数据与备份<ArrowRight :size="16" /></button
          ><button class="button secondary" @click="logoutOpen = true">
            <LogOut :size="17" />退出登录
          </button>
        </div>
        <footer class="app-footer">
          <span>简护 | Simcare</span><span>家庭健康记录 · 北京时间 GMT+8</span>
        </footer>
      </main>
    </div>
    <nav class="mobile-navigation" aria-label="手机导航">
      <button
        v-for="item in navigation"
        :key="item.id"
        :class="{
          active:
            page === item.id || (item.id === 'settings' && ['backup', 'family'].includes(page)),
        }"
        :aria-current="
          page === item.id || (item.id === 'settings' && ['family', 'backup'].includes(page))
            ? 'page'
            : undefined
        "
        @click="navigate(item.id)"
      >
        <component :is="item.icon" :size="21" /><span>{{ item.short }}</span>
      </button>
    </nav>
  </div>
  <ModalDialog v-if="memberPickerOpen" title="选择家庭成员" @close="memberPickerOpen = false"
    ><div class="member-options">
      <button
        v-for="member in members"
        :key="member.id"
        class="button secondary full-width"
        :aria-pressed="member.id === selectedMember"
        @click="
          selectedMember = member.id;
          memberPickerOpen = false;
        "
      >
        {{ member.nickname }}{{ member.id === state.session?.user.id ? '（我）' : '' }}
      </button>
    </div></ModalDialog
  >
  <Transition name="toast"
    ><div v-if="notice.message" :class="['toast-message', notice.kind]" role="status">
      <AlertCircle v-if="notice.kind === 'error'" :size="18" /><Check v-else :size="18" /><span>{{
        notice.message
      }}</span
      ><button class="icon-button" aria-label="关闭提示" @click="notice.message = ''">
        <X :size="16" />
      </button></div
  ></Transition>
  <ModalDialog v-if="logoutOpen" title="退出当前设备" @close="logoutOpen = false"
    ><p class="modal-description">
      退出会清除本机缓存。{{
        state.pendingCount
          ? `当前有 ${state.pendingCount} 条待同步记录，请先完成同步。`
          : '已同步数据保留在家庭服务器中。'
      }}
    </p>
    <footer class="modal-actions">
      <button class="button secondary" @click="logoutOpen = false">取消</button
      ><button
        class="button danger-button"
        :disabled="actionBusy || state.pendingCount > 0"
        @click="logout"
      >
        退出并清除本机数据
      </button>
    </footer></ModalDialog
  >

  <ModalDialog v-if="conflictOpen" title="同步待处理" wide @close="conflictOpen = false"
    ><article v-for="conflict in state.conflicts" :key="conflict.operationId" class="conflict-row">
      <h3>{{ conflict.resource === 'health' ? '健康记录' : '用药计划' }}</h3>
      <p class="form-error">{{ conflict.error }}</p>
      <div class="conflict-versions">
        <div><strong>这台手机的记录</strong><RecordDetails :record="conflict.local" /></div>
        <div><strong>家人已保存的记录</strong><RecordDetails :record="conflict.server" /></div>
      </div>
      <div class="modal-actions">
        <button class="button secondary" @click="resolve(conflict.operationId, 'server')">
          采用家人已保存的记录</button
        ><button
          v-if="conflict.kind === 'version'"
          class="button primary"
          @click="resolve(conflict.operationId, 'local')"
        >
          保留这台手机的修改并重试
        </button>
      </div>
    </article>
    <p v-if="!state.conflicts.length" class="muted">没有待处理的同步冲突</p></ModalDialog
  >
</template>
