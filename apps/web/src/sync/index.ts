import { protectedOperation, updateSafety } from '../update/safety';
import { reactive, watch } from 'vue';
import {
  beijingNow,
  canCreateHealth,
  canEditOwned,
  canViewHealth,
  healthInputSchema,
  medicationInputSchema,
  type ApiResponse,
  type HealthInput,
  type HealthRecord,
  type Medication,
  type MedicationInput,
  type Session,
  type SyncOperation,
  type SyncResult,
  type SyncSnapshot,
} from '@simcare/shared';
import {
  SimCareDatabase,
  type PendingOperation,
  type StoredRecord,
  type Workspace,
} from '../storage/database';
import { browserSyncChannel, type SyncChannel } from './channel';

export interface SyncConflict {
  operationId: string;
  resource: SyncOperation['resource'];
  recordId: string;
  local: StoredRecord;
  server: StoredRecord | null;
  kind: 'version' | 'rejected' | 'epoch';
  error: string;
}
export interface LocalSyncState {
  session: Session | null;
  snapshot: SyncSnapshot | null;
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  conflicts: SyncConflict[];
  error: string | null;
}
class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const emptySnapshot = (epoch: string): SyncSnapshot => ({
  epoch,
  revision: '',
  members: [],
  grants: [],
  healthRecords: [],
  medications: [],
});
const records = (snapshot: SyncSnapshot, resource: SyncOperation['resource']): StoredRecord[] =>
  resource === 'health' ? snapshot.healthRecords : snapshot.medications;
function putRecord(
  snapshot: SyncSnapshot,
  resource: SyncOperation['resource'],
  record: StoredRecord,
): void {
  const target = records(snapshot, resource);
  const index = target.findIndex((item) => item.id === record.id);
  if (index < 0) target.push(clone(record));
  else target[index] = clone(record);
}
function operationInput(
  resource: SyncOperation['resource'],
  record: StoredRecord,
): HealthInput | MedicationInput {
  const {
    id: _id,
    version: _version,
    recordedBy: _recordedBy,
    updatedBy: _updatedBy,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...data
  } = record;
  return resource === 'health' ? healthInputSchema.parse(data) : medicationInputSchema.parse(data);
}

export function createSyncClient(
  options: {
    databaseName?: string;
    fetcher?: typeof fetch;
    isOnline?: () => boolean;
    channelFactory?: (name: string) => SyncChannel | null;
  } = {},
) {
  const database = new SimCareDatabase(options.databaseName);
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  const state = reactive<LocalSyncState>({
    session: null,
    snapshot: null,
    online: isOnline(),
    syncing: false,
    pendingCount: 0,
    conflicts: [],
    error: null,
  });
  let generation = 0;
  let running: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 5000;
  let disposed = false;
  let identityVersion: string | undefined;
  const channel = (options.channelFactory ?? browserSyncChannel)(`simcare:${database.name}`);
  const unsubscribe = channel?.listen(async () => {
    if (disposed || !state.session) return;
    try {
      await publish(state.session.user.id);
    } catch (error) {
      if (!disposed) state.error = error instanceof Error ? error.message : '本地状态更新失败';
    }
  });
  const notify = () => {
    if (!disposed) channel?.postMessage({ type: 'refresh' });
  };
  async function readIdentity() {
    const [current, version] = await database.metadata.bulkGet(['currentUser', 'identityVersion']);
    return { userId: current?.value, version: version?.value };
  }
  function invalidateMemory(): void {
    generation += 1;
    if (retryTimer) clearTimeout(retryTimer);
    clearMemory();
  }

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetcher(`/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !envelope.success) {
      throw new ApiFailure(
        response.status,
        envelope.error?.code ?? 'NETWORK_ERROR',
        envelope.error?.message ?? '同步请求失败',
      );
    }
    return envelope.data;
  }
  const pendingFor = (userId: string) =>
    database.outbox.where('userId').equals(userId).sortBy('sequence');
  function project(workspace: Workspace, pending: PendingOperation[]): SyncSnapshot {
    const snapshot = clone(workspace.serverSnapshot);
    for (const entry of pending) {
      if (entry.status !== 'stale' && entry.operation.epoch === snapshot.epoch)
        putRecord(snapshot, entry.operation.resource, entry.local);
    }
    return snapshot;
  }
  async function publish(userId: string, token = generation): Promise<void> {
    if (disposed) return;
    const [workspace, pending, identity] = await database.transaction(
      'r',
      database.workspaces,
      database.outbox,
      database.metadata,
      async () =>
        Promise.all([database.workspaces.get(userId), pendingFor(userId), readIdentity()]),
    );
    if (disposed || token !== generation || state.session?.user.id !== userId) return;
    if (!workspace || identity.userId !== userId || !workspace.session.user.active) {
      invalidateMemory();
      return;
    }
    if (identityVersion !== identity.version) {
      generation += 1;
      identityVersion = identity.version;
    }
    state.session = clone(workspace.session);
    state.snapshot = clone(workspace.snapshot);
    state.pendingCount = pending.length;
    state.conflicts = pending
      .filter((entry) => entry.status !== 'pending')
      .map((entry) => ({
        operationId: entry.operationId,
        resource: entry.operation.resource,
        recordId: entry.operation.recordId,
        local: clone(entry.local),
        server: entry.server ? clone(entry.server) : null,
        kind:
          entry.status === 'stale' ? 'epoch' : entry.status === 'failed' ? 'rejected' : 'version',
        error: entry.error ?? '记录已在其他设备修改，请处理冲突',
      }));
  }
  function clearMemory(): void {
    state.session = null;
    state.snapshot = null;
    state.pendingCount = 0;
    state.conflicts = [];
  }
  async function expireSession(message: string): Promise<void> {
    const userId = state.session?.user.id;
    invalidateMemory();
    await database.transaction('rw', database.metadata, async () => {
      const identity = await readIdentity();
      if (identity.userId === userId) {
        await database.metadata.delete('currentUser');
        identityVersion = crypto.randomUUID();
        await database.metadata.put({ key: 'identityVersion', value: identityVersion });
      }
    });
    notify();
    state.error = message;
  }
  async function acceptSession(session: Session, synchronize = true): Promise<void> {
    if (disposed) throw new Error('同步客户端已关闭');
    if (!session.user.active) throw new ApiFailure(401, 'ACCOUNT_DISABLED', '账户已停用');
    generation += 1;
    clearMemory();
    state.session = clone(session);
    state.error = null;
    await database.transaction('rw', database.workspaces, database.metadata, async () => {
      const existing = await database.workspaces.get(session.user.id);
      const snapshot = emptySnapshot(session.epoch);
      await database.workspaces.put(
        existing
          ? { ...existing, session: clone(session) }
          : {
              userId: session.user.id,
              session: clone(session),
              snapshot,
              serverSnapshot: snapshot,
              sequence: 0,
            },
      );
      await database.metadata.put({ key: 'currentUser', value: session.user.id });
      identityVersion = crypto.randomUUID();
      await database.metadata.put({ key: 'identityVersion', value: identityVersion });
    });
    notify();
    await publish(session.user.id);
    if (synchronize && isOnline()) {
      if (running) await running;
      await syncNow();
    }
  }
  async function initialize(): Promise<void> {
    if (disposed) return;
    state.online = isOnline();
    const current = await readIdentity();
    identityVersion = current.version;
    const workspace = current.userId ? await database.workspaces.get(current.userId) : undefined;
    if (workspace) {
      state.session = clone(workspace.session);
      await publish(workspace.userId);
    }
    if (state.online) await syncNow();
  }
  function mayWrite(workspace: Workspace, operation: SyncOperation, ownerId: string): boolean {
    const actor = workspace.session.user;
    if (
      operation.resource === 'medication' ||
      operation.action !== 'upsert' ||
      operation.baseVersion > 0
    )
      return canEditOwned(actor, ownerId);
    return canCreateHealth(actor, ownerId, workspace.serverSnapshot.grants);
  }
  async function applySnapshot(
    userId: string,
    snapshot: SyncSnapshot,
    session: Session,
    requestedEpoch: string,
    requestedIdentity: string | undefined,
  ): Promise<void> {
    await database.transaction(
      'rw',
      database.workspaces,
      database.outbox,
      database.metadata,
      async () => {
        const workspace = await database.workspaces.get(userId);
        const identity = await readIdentity();
        if (!workspace || identity.userId !== userId || identity.version !== requestedIdentity)
          return;
        if (
          workspace.serverSnapshot.epoch !== requestedEpoch &&
          workspace.serverSnapshot.epoch !== snapshot.epoch
        )
          return;
        if (!/^\d+$/.test(snapshot.revision)) throw new Error('服务器同步版本无效');
        if (
          workspace.serverSnapshot.epoch === snapshot.epoch &&
          /^\d+$/.test(workspace.serverSnapshot.revision) &&
          BigInt(snapshot.revision) < BigInt(workspace.serverSnapshot.revision)
        )
          return;
        const member = snapshot.members.find((item) => item.id === userId);
        if (!member?.active)
          throw new ApiFailure(401, 'ACCOUNT_DISABLED', '账户已停用或不再属于家庭');
        workspace.session = clone({ ...session, user: member, epoch: snapshot.epoch });
        workspace.serverSnapshot = clone(snapshot);
        const entries = await pendingFor(userId);
        for (const entry of entries) {
          const hasRead =
            entry.operation.resource === 'medication' ||
            canViewHealth(member, entry.local.ownerId, snapshot.grants);
          if (!hasRead || !mayWrite(workspace, entry.operation, entry.local.ownerId)) {
            await database.outbox.delete(entry.operationId);
            continue;
          }
          if (entry.operation.epoch !== snapshot.epoch) {
            entry.status = 'stale';
            entry.error = '系统已恢复备份，旧队列已隔离。请核对后重新录入，不能自动重放。';
            await database.outbox.put(entry);
          }
        }
        workspace.snapshot = project(workspace, await pendingFor(userId));
        await database.workspaces.put(workspace);
      },
    );
    notify();
  }
  async function queue(
    resource: SyncOperation['resource'],
    action: SyncOperation['action'],
    data?: HealthInput | MedicationInput,
    id?: string,
    baseVersion?: number,
  ): Promise<StoredRecord> {
    const session = state.session;
    if (!session || disposed) throw new Error('请先登录后再录入');
    const recordId = id ?? crypto.randomUUID();
    let saved!: StoredRecord;
    await database.transaction(
      'rw',
      database.workspaces,
      database.outbox,
      database.metadata,
      async () => {
        if ((await readIdentity()).userId !== session.user.id)
          throw new Error('登录身份已变化，请重新登录');
        const workspace = await database.workspaces.get(session.user.id);
        if (!workspace || workspace.session.epoch !== workspace.serverSnapshot.epoch)
          throw new Error('请先联网更新系统状态');
        const existing = records(workspace.snapshot, resource).find((item) => item.id === recordId);
        if (id && !existing) throw new Error('记录不存在或没有访问权限');
        if (baseVersion !== undefined && baseVersion !== (existing?.version ?? 0))
          throw new Error('本地记录已变化，请重新打开后修改');
        const input = data ?? (existing ? operationInput(resource, existing) : undefined);
        if (!input) throw new Error('缺少记录内容');
        if (existing && input.ownerId !== existing.ownerId) throw new Error('不能更改记录所属成员');
        const operation: SyncOperation = {
          operationId: crypto.randomUUID(),
          epoch: workspace.serverSnapshot.epoch,
          resource,
          recordId,
          baseVersion: existing?.version ?? 0,
          action,
          ...(action === 'upsert' ? { data: clone(input) } : {}),
        };
        if (!mayWrite(workspace, operation, input.ownerId)) throw new Error('没有修改此记录的权限');
        const now = beijingNow();
        saved = {
          ...clone(input),
          id: recordId,
          version: operation.baseVersion + 1,
          recordedBy: existing?.recordedBy ?? session.user.id,
          updatedBy: session.user.id,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          deletedAt:
            action === 'delete' ? now : action === 'restore' ? null : (existing?.deletedAt ?? null),
        } as StoredRecord;
        const previous = (await pendingFor(session.user.id))
          .filter(
            (entry) =>
              entry.operation.recordId === recordId && entry.operation.resource === resource,
          )
          .at(-1);
        if (previous?.status === 'stale') throw new Error('请先处理该记录的备份恢复冲突');
        workspace.sequence += 1;
        await database.outbox.add({
          operationId: operation.operationId,
          userId: session.user.id,
          sequence: workspace.sequence,
          operation,
          local: clone(saved),
          status: 'pending',
          attempted: false,
          ...(previous ? { predecessorId: previous.operationId } : {}),
        });
        putRecord(workspace.snapshot, resource, saved);
        await database.workspaces.put(workspace);
      },
    );
    await publish(session.user.id);
    notify();
    if (isOnline()) void syncNow();
    return saved;
  }
  async function applyResult(userId: string, result: SyncResult): Promise<void> {
    await database.transaction(
      'rw',
      database.workspaces,
      database.outbox,
      database.metadata,
      async () => {
        const workspace = await database.workspaces.get(userId);
        const entry = await database.outbox.get(result.operationId);
        if (
          !workspace ||
          !entry ||
          entry.userId !== userId ||
          (await readIdentity()).userId !== userId ||
          entry.operation.epoch !== workspace.serverSnapshot.epoch
        )
          return;
        if (result.status === 'applied' && result.record) {
          const existing = records(workspace.serverSnapshot, entry.operation.resource).find(
            (item) => item.id === result.record!.id,
          );
          if (!existing || existing.version <= result.record.version)
            putRecord(workspace.serverSnapshot, entry.operation.resource, result.record);
          await database.outbox.delete(entry.operationId);
        } else if (result.error?.code === 'FORBIDDEN' || result.error?.code === 'NOT_FOUND') {
          const related = (await pendingFor(userId)).filter(
            (item) =>
              item.operation.resource === entry.operation.resource &&
              item.operation.recordId === entry.operation.recordId,
          );
          await database.outbox.bulkDelete(related.map((item) => item.operationId));
          if (entry.operation.resource === 'health')
            workspace.serverSnapshot.healthRecords = workspace.serverSnapshot.healthRecords.filter(
              (record) => record.id !== entry.operation.recordId,
            );
          else
            workspace.serverSnapshot.medications = workspace.serverSnapshot.medications.filter(
              (record) => record.id !== entry.operation.recordId,
            );
          state.error = result.error.message;
        } else {
          entry.status =
            result.error?.code === 'EPOCH_CHANGED'
              ? 'stale'
              : result.status === 'conflict'
                ? 'conflict'
                : 'failed';
          entry.server = result.record;
          entry.error = result.error?.message ?? '同步未完成，请核对记录';
          await database.outbox.put(entry);
        }
        workspace.snapshot = project(workspace, await pendingFor(userId));
        await database.workspaces.put(workspace);
      },
    );
    notify();
  }
  async function performSync(): Promise<void> {
    state.online = isOnline();
    if (!state.online) return;
    let token = generation;
    state.syncing = true;
    state.error = null;
    try {
      const initialIdentity = await readIdentity();
      const session = await request<Session>('/auth/session');
      if (token !== generation) return;
      const verifiedIdentity = await readIdentity();
      if (initialIdentity.version !== verifiedIdentity.version) {
        await publish(state.session?.user.id ?? '');
        return;
      }
      if (!state.session || state.session.user.id !== session.user.id) {
        await acceptSession(session, false);
        token = generation;
      }
      if (!session.user.active) {
        await expireSession('账户已停用');
        return;
      }
      const userId = session.user.id;
      const requestedIdentity = identityVersion;
      const requestedEpoch = (await database.workspaces.get(userId))!.serverSnapshot.epoch;
      const snapshot = await request<SyncSnapshot>('/sync/pull');
      if (token !== generation) return;
      await applySnapshot(
        userId,
        snapshot,
        { ...session, epoch: snapshot.epoch },
        requestedEpoch,
        requestedIdentity,
      );
      await publish(userId, token);
      let count = 0;
      while (token === generation && count < 200) {
        const entries = await pendingFor(userId);
        const eligible = entries
          .filter(
            (entry) =>
              entry.status === 'pending' &&
              entry.operation.epoch === snapshot.epoch &&
              !entries.some((other) => other.operationId === entry.predecessorId),
          )
          .slice(0, 1);
        if (!eligible.length) break;
        await database.transaction('rw', database.outbox, database.metadata, async () => {
          if ((await readIdentity()).version !== requestedIdentity)
            throw new Error('登录身份已变化');
          for (const entry of eligible)
            await database.outbox.update(entry.operationId, { attempted: true });
        });
        const results = await request<SyncResult[]>('/sync/push', {
          operations: eligible.map((entry) => entry.operation),
        });
        if (token !== generation) return;
        for (const result of results)
          if (eligible.some((entry) => entry.operationId === result.operationId))
            if ((await readIdentity()).version === requestedIdentity)
              await applyResult(userId, result);
        await publish(userId, token);
        count += eligible.length;
        if (results.length === 0) throw new Error('服务器未确认同步结果');
      }
      const latestEpoch = (await database.workspaces.get(userId))?.serverSnapshot.epoch;
      if (!latestEpoch) return;
      const latest = await request<SyncSnapshot>('/sync/pull');
      if (token !== generation) return;
      await applySnapshot(
        userId,
        latest,
        { ...session, epoch: latest.epoch },
        latestEpoch,
        requestedIdentity,
      );
      await publish(userId, token);
    } catch (error) {
      if (token !== generation) return;
      if (
        error instanceof ApiFailure &&
        (error.status === 401 || error.code === 'ACCOUNT_DISABLED')
      )
        await expireSession(error.message);
      else state.error = error instanceof Error ? error.message : '同步失败，数据仍保存在此设备';
    } finally {
      state.syncing = false;
    }
  }
  async function syncNow(): Promise<void> {
    if (updateSafety.locked) return;
    if (running) return running;
    if (retryTimer) clearTimeout(retryTimer);
    running = protectedOperation(performSync);
    try {
      await running;
    } finally {
      running = null;
      if (
        typeof window !== 'undefined' &&
        state.session &&
        state.error &&
        state.pendingCount > 0 &&
        isOnline()
      ) {
        retryTimer = setTimeout(() => {
          void syncNow();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60000);
      } else retryDelay = 5000;
    }
  }
  async function resolveConflict(operationId: string, choice: 'server' | 'local'): Promise<void> {
    const session = state.session;
    if (!session) throw new Error('请先登录');
    await database.transaction(
      'rw',
      database.workspaces,
      database.outbox,
      database.metadata,
      async () => {
        if ((await readIdentity()).userId !== session.user.id) throw new Error('登录身份已变化');
        const workspace = await database.workspaces.get(session.user.id);
        const entry = await database.outbox.get(operationId);
        if (!workspace || !entry || entry.userId !== session.user.id) throw new Error('冲突不存在');
        if (choice === 'local' && entry.status === 'stale')
          throw new Error('备份恢复前的记录不能自动重放，请核对后重新录入');
        const entries = await pendingFor(session.user.id);
        const related = entries.filter(
          (item) =>
            item.operation.resource === entry.operation.resource &&
            item.operation.recordId === entry.operation.recordId,
        );
        const latest = related.at(-1) ?? entry;
        for (const item of related) await database.outbox.delete(item.operationId);
        const currentRecord = records(workspace.serverSnapshot, entry.operation.resource).find(
          (item) => item.id === entry.operation.recordId,
        );
        if (entry.server && (!currentRecord || currentRecord.version <= entry.server.version))
          putRecord(workspace.serverSnapshot, entry.operation.resource, entry.server);
        if (choice === 'local') {
          const current = records(workspace.serverSnapshot, entry.operation.resource).find(
            (item) => item.id === entry.operation.recordId,
          );
          const operation = {
            ...latest.operation,
            operationId: crypto.randomUUID(),
            epoch: workspace.serverSnapshot.epoch,
            baseVersion: current?.version ?? 0,
          };
          if (!mayWrite(workspace, operation, latest.local.ownerId))
            throw new Error('当前没有修改权限');
          workspace.sequence += 1;
          await database.outbox.add({
            operationId: operation.operationId,
            userId: session.user.id,
            sequence: workspace.sequence,
            operation,
            local: { ...latest.local, version: operation.baseVersion + 1 },
            status: 'pending',
            attempted: false,
          });
        }
        workspace.snapshot = project(workspace, await pendingFor(session.user.id));
        await database.workspaces.put(workspace);
      },
    );
    await publish(session.user.id);
    if (isOnline()) await syncNow();
  }
  async function logoutLocal(): Promise<void> {
    if (retryTimer) clearTimeout(retryTimer);
    const userId = state.session?.user.id;
    generation += 1;
    clearMemory();
    state.error = null;
    await database.transaction(
      'rw',
      database.workspaces,
      database.outbox,
      database.metadata,
      async () => {
        if (userId) {
          await database.workspaces.delete(userId);
          await database.outbox.where('userId').equals(userId).delete();
        }
        if ((await readIdentity()).userId === userId) {
          await database.metadata.delete('currentUser');
          identityVersion = crypto.randomUUID();
          await database.metadata.put({ key: 'identityVersion', value: identityVersion });
        }
      },
    );
    notify();
  }
  function dispose(): void {
    disposed = true;
    invalidateMemory();
    unsubscribe?.();
    channel?.close();
    database.close();
  }
  return {
    dispose,
    state,
    database,
    initialize: () => protectedOperation(initialize),
    acceptSession: (session: Session, synchronize = true) =>
      protectedOperation(() => acceptSession(session, synchronize)),
    logoutLocal: () => protectedOperation(logoutLocal),
    syncNow,
    resolveConflict: (id: string, choice: 'server' | 'local') =>
      protectedOperation(() => resolveConflict(id, choice)),
    saveHealth: (input: HealthInput, id?: string, baseVersion?: number) =>
      protectedOperation(
        () =>
          queue(
            'health',
            'upsert',
            healthInputSchema.parse(input),
            id,
            baseVersion,
          ) as Promise<HealthRecord>,
      ),
    saveMedication: (input: MedicationInput, id?: string, baseVersion?: number) =>
      protectedOperation(
        () =>
          queue(
            'medication',
            'upsert',
            medicationInputSchema.parse(input),
            id,
            baseVersion,
          ) as Promise<Medication>,
      ),
    deleteRecord: (resource: SyncOperation['resource'], id: string, baseVersion: number) =>
      protectedOperation(() => queue(resource, 'delete', undefined, id, baseVersion)),
    restoreRecord: (resource: SyncOperation['resource'], id: string, baseVersion: number) =>
      protectedOperation(() => queue(resource, 'restore', undefined, id, baseVersion)),
  };
}

export const sync = createSyncClient();
export const {
  state,
  initialize,
  acceptSession,
  logoutLocal,
  saveHealth,
  saveMedication,
  deleteRecord,
  restoreRecord,
  syncNow,
  resolveConflict,
} = sync;
export const syncState = state;
if (typeof window !== 'undefined') {
  watch(
    () => updateSafety.locked,
    (locked, previous) => {
      if (previous && !locked && state.session && state.online) void syncNow();
    },
  );
  window.addEventListener('online', () => {
    state.online = true;
    void syncNow();
  });
  window.addEventListener('offline', () => {
    state.online = false;
  });
  window.addEventListener('focus', () => {
    if (state.session) void syncNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.session) void syncNow();
  });
}
