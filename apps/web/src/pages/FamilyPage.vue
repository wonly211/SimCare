<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { Copy, ShieldCheck, UserPlus, Users, X } from 'lucide-vue-next';
import type { HouseholdRole, Invitation, Member, MemberGrant } from '@simcare/shared';
import { state, syncNow } from '../sync';
import { api, displayTime, errorMessage, notify } from '../state/client';
import ModalDialog from '../components/ModalDialog.vue';
const admin = computed(() => state.session?.user.householdRole === 'admin');
const systemAdmin = computed(() => state.session?.user.systemRole === 'system_admin');
const members = computed(() => state.snapshot?.members ?? []);
const invitations = ref<Invitation[]>([]);
const busy = ref(false);
const invitationRole = ref<HouseholdRole>('member');
const inviteOpen = ref(false);
const invitationLink = ref('');
const invitationQr = ref('');
const pendingChange = ref<{ member: Member; patch: Partial<Member>; title: string }>();
const grant = (id: string) =>
  state.snapshot?.grants.find(
    (item) => item.ownerId === state.session?.user.id && item.granteeId === id,
  )?.grant ?? 'none';
async function refreshInvitations() {
  if (!admin.value || !state.online) return;
  try {
    invitations.value = await api<Invitation[]>('/invitations');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  }
}
async function createInvitation() {
  busy.value = true;
  try {
    const result = await api<{ invitation: Invitation; token: string }>('/invitations', 'POST', {
      role: invitationRole.value,
    });
    const url = new URL(location.origin);
    url.searchParams.set('invite', result.token);
    invitationLink.value = url.href;
    invitationQr.value = await QRCode.toDataURL(url.href, { width: 240, margin: 2 });
    await refreshInvitations();
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  } finally {
    busy.value = false;
  }
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    notify('链接已复制');
  } catch {
    notify('无法访问剪贴板，请选中链接复制', 'error');
  }
}
async function updateMember() {
  if (!pendingChange.value) return;
  busy.value = true;
  try {
    await api(`/members/${pendingChange.value.member.id}`, 'PATCH', pendingChange.value.patch);
    await syncNow();
    pendingChange.value = undefined;
    notify('成员信息已更新');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  } finally {
    busy.value = false;
  }
}
async function updateGrant(member: Member, value: string) {
  try {
    await api(`/permissions/${member.id}`, 'PUT', { grant: value as MemberGrant });
    await syncNow();
    notify('授权已更新');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  }
}
async function revoke(invitation: Invitation) {
  try {
    await api(`/invitations/${invitation.id}`, 'DELETE');
    await refreshInvitations();
    notify('邀请已撤销');
  } catch (reason) {
    notify(errorMessage(reason), 'error');
  }
}
onMounted(refreshInvitations);
</script>
<template>
  <section class="page-section">
    <div class="section-heading">
      <div>
        <p class="eyebrow">家庭管理</p>
        <h1>家庭成员</h1>
        <p class="section-subtitle">
          {{ members.filter((member) => member.active).length }} 位成员 ·
          {{ state.session?.household.name }}
        </p>
      </div>
      <button
        v-if="admin"
        class="button primary"
        :disabled="!state.online"
        @click="
          inviteOpen = true;
          invitationLink = '';
          invitationQr = '';
        "
      >
        <UserPlus :size="18" />邀请成员
      </button>
    </div>
    <div class="member-list">
      <article v-for="member in members" :key="member.id" class="member-row">
        <span class="avatar large" :class="{ muted: !member.active }">{{
          member.nickname.slice(0, 1)
        }}</span>
        <div class="member-info">
          <h3>
            {{ member.nickname
            }}<span v-if="member.id === state.session?.user.id" class="badge neutral">我</span
            ><span v-if="!member.active" class="badge warning">已停用</span>
          </h3>
          <p>
            <ShieldCheck v-if="member.householdRole === 'admin'" :size="14" />{{
              member.systemRole ? '系统管理员 · ' : ''
            }}{{ member.householdRole === 'admin' ? '家庭管理员' : '家庭成员' }}
          </p>
        </div>
        <div class="member-permission">
          <span v-if="member.householdRole === 'admin'" class="permission-fixed">家庭照护权限</span
          ><label v-else-if="member.id !== state.session?.user.id"
            >对我的健康记录<select
              :value="grant(member.id)"
              :disabled="!state.online || !member.active"
              @change="updateGrant(member, ($event.target as HTMLSelectElement).value)"
            >
              <option value="none">无权限</option>
              <option value="view">查看</option>
              <option value="care">照护</option>
            </select></label
          >
        </div>
        <div v-if="admin && member.id !== state.session?.user.id" class="member-admin-actions">
          <button
            v-if="systemAdmin && !member.systemRole"
            class="text-button"
            :disabled="!state.online"
            @click="
              pendingChange = {
                member,
                patch: { householdRole: member.householdRole === 'admin' ? 'member' : 'admin' },
                title: member.householdRole === 'admin' ? '撤销管理员' : '设为管理员',
              }
            "
          >
            {{ member.householdRole === 'admin' ? '撤销管理员' : '设为管理员' }}</button
          ><button
            v-if="!member.systemRole && (systemAdmin || member.householdRole === 'member')"
            class="text-button"
            :disabled="!state.online"
            @click="
              pendingChange = {
                member,
                patch: { active: !member.active },
                title: member.active ? '停用成员' : '启用成员',
              }
            "
          >
            {{ member.active ? '停用' : '启用' }}
          </button>
        </div>
      </article>
    </div>
    <section v-if="admin" class="invitation-section">
      <div class="section-heading compact">
        <h2>邀请记录</h2>
        <span class="muted">有效期 24 小时</span>
      </div>
      <div v-if="!invitations.length" class="small-empty horizontal">
        <Users :size="22" />
        <p>暂无邀请记录</p>
      </div>
      <div v-for="invitation in invitations" :key="invitation.id" class="invitation-row">
        <span>{{ invitation.role === 'admin' ? '家庭管理员' : '普通成员' }}</span
        ><span class="muted">{{ displayTime(invitation.expiresAt) }} 到期</span
        ><span class="badge neutral">{{
          invitation.revokedAt
            ? '已撤销'
            : invitation.usedAt
              ? '已使用'
              : Date.parse(invitation.expiresAt) < Date.now()
                ? '已过期'
                : '待加入'
        }}</span
        ><button
          v-if="!invitation.revokedAt && !invitation.usedAt"
          class="icon-button"
          :disabled="!state.online"
          title="撤销邀请"
          aria-label="撤销邀请"
          @click="revoke(invitation)"
        >
          <X :size="16" />
        </button>
      </div>
    </section>
    <ModalDialog v-if="inviteOpen" title="邀请家庭成员" @close="inviteOpen = false"
      ><div v-if="invitationLink" class="qr-view">
        <img :src="invitationQr" alt="家庭邀请二维码" width="240" height="240" /><input
          :value="invitationLink"
          readonly
          aria-label="邀请链接"
        /><button class="button secondary" @click="copy(invitationLink)">
          <Copy :size="17" />复制邀请链接
        </button>
        <p class="muted">一次性邀请 · 24 小时有效 · 加入后需批准设备</p>
      </div>
      <form v-else class="form-stack" @submit.prevent="createInvitation">
        <label
          >成员角色<select v-model="invitationRole">
            <option value="member">普通成员</option>
          </select></label
        ><button class="button primary" :disabled="busy"><UserPlus :size="17" />生成邀请</button>
      </form></ModalDialog
    >
    <ModalDialog
      v-if="pendingChange"
      :title="pendingChange.title"
      @close="pendingChange = undefined"
      ><p class="modal-description">
        确认对 {{ pendingChange.member.nickname }} 执行“{{ pendingChange.title }}”？历史记录将保留。
      </p>
      <footer class="modal-actions">
        <button class="button secondary" @click="pendingChange = undefined">取消</button
        ><button class="button primary" :disabled="busy" @click="updateMember">确认</button>
      </footer></ModalDialog
    >
  </section>
</template>
