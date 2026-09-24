import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  HealthInput,
  HealthRecord,
  Session,
  SyncOperation,
  SyncResult,
  SyncSnapshot,
} from '@simcare/shared';
import { beijingNow } from '@simcare/shared';
import { createSyncClient } from './index';
import type { SyncChannel } from './channel';

const ownerId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const session: Session = {
  user: {
    id: ownerId,
    nickname: '测试成员',
    systemRole: null,
    householdRole: 'member',
    active: true,
    createdAt: beijingNow(),
  },
  household: { id: 'family', name: '测试家庭' },
  epoch: 'epoch-1',
};
const input: HealthInput = {
  ownerId,
  measuredAt: '2026-09-22T08:00:00+08:00',
  systolic: 120,
  diastolic: 80,
  pulse: 70,
  oxygen: null,
  temperature: null,
  posture: 'sitting',
  arm: 'left',
  note: '',
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const clients: ReturnType<typeof createSyncClient>[] = [];
afterEach(async () => {
  const closing = clients.splice(0);
  for (const client of closing) client.dispose();
  for (const client of closing) await client.database.delete();
});

function setup(databaseName = crypto.randomUUID()) {
  let online = false;
  let authenticated = true;
  let dropPushResponse = false;
  let beforePush: (() => Promise<void>) | undefined;
  let beforePull: ((value: SyncSnapshot) => Promise<SyncSnapshot>) | undefined;
  const listeners = new Set<(message: unknown) => Promise<void>>();
  const channelFactory = (): SyncChannel => {
    let ownListener: ((message: unknown) => Promise<void>) | undefined;
    return {
      postMessage(message) {
        for (const listener of listeners) if (listener !== ownListener) void listener(message);
      },
      listen(listener) {
        ownListener = listener;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close() {
        if (ownListener) listeners.delete(ownListener);
      },
    };
  };
  const currentSession = copy(session);
  const snapshot: SyncSnapshot = {
    epoch: session.epoch,
    revision: '1',
    members: [session.user],
    grants: [],
    healthRecords: [],
    medications: [],
  };
  const applied = new Map<string, SyncResult>();
  const operations: SyncOperation[] = [];
  const pushSizes: number[] = [];
  const ok = (data: unknown) =>
    Response.json({ success: true, data, error: null, request_id: 'test' });
  const fetcher: typeof fetch = async (url, init) => {
    if (!online) throw new TypeError('offline');
    if (!authenticated)
      return Response.json(
        {
          success: false,
          data: null,
          error: { code: 'UNAUTHENTICATED', message: '请重新登录' },
          request_id: 'test',
        },
        { status: 401 },
      );
    if (String(url).endsWith('/auth/session')) return ok(currentSession);
    if (String(url).endsWith('/sync/pull')) {
      const pending = beforePull;
      beforePull = undefined;
      return ok(pending ? await pending(copy(snapshot)) : copy(snapshot));
    }
    if (String(url).endsWith('/sync/push')) {
      if (beforePush) {
        const pending = beforePush;
        beforePush = undefined;
        await pending();
      }
      const body = JSON.parse(String(init?.body)) as { operations: SyncOperation[] };
      pushSizes.push(body.operations.length);
      const results = body.operations.map((operation) => {
        operations.push(copy(operation));
        const existingResult = applied.get(operation.operationId);
        if (existingResult) return existingResult;
        const existing = snapshot.healthRecords.find((item) => item.id === operation.recordId);
        if ((existing?.version ?? 0) !== operation.baseVersion)
          return {
            operationId: operation.operationId,
            status: 'conflict',
            record: existing,
          } satisfies SyncResult;
        const record: HealthRecord = {
          ...((operation.data as HealthInput) ?? existing!),
          id: operation.recordId,
          version: operation.baseVersion + 1,
          recordedBy: existing?.recordedBy ?? ownerId,
          updatedBy: ownerId,
          createdAt: existing?.createdAt ?? beijingNow(),
          updatedAt: beijingNow(),
          deletedAt:
            operation.action === 'delete'
              ? beijingNow()
              : operation.action === 'restore'
                ? null
                : (existing?.deletedAt ?? null),
        };
        snapshot.healthRecords = snapshot.healthRecords.filter((item) => item.id !== record.id);
        snapshot.healthRecords.push(record);
        snapshot.revision = String(Number(snapshot.revision) + 1);
        const result: SyncResult = {
          operationId: operation.operationId,
          status: 'applied',
          record,
        };
        applied.set(operation.operationId, result);
        return result;
      });
      if (dropPushResponse) {
        dropPushResponse = false;
        throw new TypeError('连接中断');
      }
      return ok(results);
    }
    throw new Error(`Unexpected ${String(url)}`);
  };
  const newClient = () => {
    const client = createSyncClient({
      databaseName,
      fetcher,
      isOnline: () => online,
      channelFactory,
    });
    clients.push(client);
    return client;
  };
  return {
    client: newClient(),
    newClient,
    snapshot,
    operations,
    pushSizes,
    currentSession,
    online: () => {
      online = true;
    },
    offline: () => {
      online = false;
    },
    expire: () => {
      authenticated = false;
    },
    login: () => {
      authenticated = true;
    },
    loseResponse: () => {
      dropPushResponse = true;
    },
    beforePush: (callback: () => Promise<void>) => {
      beforePush = callback;
    },
    beforePull: (callback: (value: SyncSnapshot) => Promise<SyncSnapshot>) => {
      beforePull = callback;
    },
  };
}

describe('local-first sync', () => {
  it('propagates logout to another open tab and rejects further local writes', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    const other = env.newClient();
    await other.initialize();
    await env.client.logoutLocal();
    await expect.poll(() => other.state.session).toBeNull();
    expect(other.state.snapshot).toBeNull();
    await expect(other.saveHealth(input)).rejects.toThrow('请先登录');
  });
  it('propagates session expiry while retaining the isolated unsynced queue', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    const other = env.newClient();
    await other.initialize();
    env.online();
    env.expire();
    await env.client.syncNow();
    await expect.poll(() => other.state.session).toBeNull();
    expect(await other.database.outbox.count()).toBe(1);
  });
  it('never reapplies an older permission snapshot arriving after a newer revision', async () => {
    const env = setup();
    env.snapshot.grants = [{ ownerId: otherId, granteeId: ownerId, grant: 'care' }];
    env.online();
    await env.client.initialize();
    const other = env.newClient();
    await other.initialize();
    let release!: () => void;
    let captured!: () => void;
    const started = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.beforePull(async (snapshot) => {
      captured();
      await gate;
      return snapshot;
    });
    const slow = env.client.syncNow();
    await started;
    env.snapshot.grants = [];
    env.snapshot.revision = '2';
    await other.syncNow();
    release();
    await slow;
    expect(env.client.state.snapshot?.revision).toBe('2');
    expect(env.client.state.snapshot?.grants).toEqual([]);
  });
  it('never reactivates an old epoch when a pre-restore request arrives late', async () => {
    const env = setup();
    env.online();
    await env.client.initialize();
    const other = env.newClient();
    await other.initialize();
    let release!: () => void;
    let captured!: () => void;
    const started = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.beforePull(async (snapshot) => {
      captured();
      await gate;
      return snapshot;
    });
    const slow = env.client.syncNow();
    await started;
    env.snapshot.epoch = 'restored';
    env.snapshot.revision = '0';
    env.currentSession.epoch = 'restored';
    await other.syncNow();
    release();
    await slow;
    expect(env.client.state.snapshot?.epoch).toBe('restored');
  });
  it('persists an atomic local record and queue through offline reload', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    const saved = await env.client.saveHealth(input);
    expect(env.client.state.pendingCount).toBe(1);
    env.client.database.close();
    const reopened = env.newClient();
    await reopened.initialize();
    expect(reopened.state.snapshot?.healthRecords[0].id).toBe(saved.id);
    expect(reopened.state.pendingCount).toBe(1);
  });
  it('bootstraps a verified online session and downloads its snapshot', async () => {
    const env = setup();
    env.online();
    await env.client.initialize();
    expect(env.client.state.session?.user.id).toBe(ownerId);
    expect(env.client.state.snapshot?.members).toHaveLength(1);
  });
  it('retries exactly the same operation after server commit but lost response', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    env.online();
    env.loseResponse();
    await env.client.syncNow();
    expect(env.client.state.pendingCount).toBe(1);
    await env.client.syncNow();
    expect(env.client.state.pendingCount).toBe(0);
    expect(env.snapshot.healthRecords).toHaveLength(1);
    expect(env.operations[0].operationId).toBe(env.operations[1].operationId);
  });
  it('keeps sequential local edits behind their acknowledged predecessor', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    const saved = await env.client.saveHealth(input);
    await env.client.saveHealth({ ...input, note: '第二次修改' }, saved.id, saved.version);
    env.online();
    await env.client.syncNow();
    expect(env.snapshot.healthRecords[0].version).toBe(2);
    expect(env.snapshot.healthRecords[0].note).toBe('第二次修改');
    expect(env.operations.map((item) => item.baseVersion)).toEqual([0, 1]);
  });
  it('sends only one eligible operation per request for the D1 Free query budget', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    await env.client.saveHealth({ ...input, note: '独立记录二' });
    await env.client.saveHealth({ ...input, note: '独立记录三' });
    env.online();
    await env.client.syncNow();
    expect(env.pushSizes).toEqual([1, 1, 1]);
    expect(env.snapshot.healthRecords).toHaveLength(3);
    expect(env.client.state.pendingCount).toBe(0);
  });
  it('keeps both conflict versions and resolves using a fresh operation id', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    const saved = await env.client.saveHealth(input);
    env.online();
    await env.client.syncNow();
    env.offline();
    await env.client.saveHealth({ ...input, note: '本地' }, saved.id, 1);
    env.snapshot.healthRecords[0] = { ...env.snapshot.healthRecords[0], version: 2, note: '远端' };
    env.online();
    await env.client.syncNow();
    const conflict = env.client.state.conflicts[0];
    expect(conflict.local.note).toBe('本地');
    expect(conflict.server?.note).toBe('远端');
    await env.client.resolveConflict(conflict.operationId, 'local');
    expect(env.snapshot.healthRecords[0].note).toBe('本地');
    expect(env.snapshot.healthRecords[0].version).toBe(3);
    expect(env.client.state.conflicts).toHaveLength(0);
  });
  it('deduplicates simultaneous tab uploads and respects the same predecessor chain', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    const saved = await env.client.saveHealth(input);
    await env.client.saveHealth({ ...input, note: '跨标签页连续修改' }, saved.id, 1);
    const secondTab = env.newClient();
    await secondTab.initialize();
    env.online();
    await Promise.all([env.client.syncNow(), secondTab.syncNow()]);
    expect(env.snapshot.healthRecords).toHaveLength(1);
    expect(env.snapshot.healthRecords[0].version).toBe(2);
    expect(env.snapshot.healthRecords[0].note).toBe('跨标签页连续修改');
    expect(new Set(env.operations.map((operation) => operation.operationId)).size).toBe(2);
    expect(env.client.state.pendingCount).toBe(0);
    expect(secondTab.state.pendingCount).toBe(0);
  });
  it('rejects one of two stale form edits in simultaneous offline tabs', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    const saved = await env.client.saveHealth(input);
    const secondTab = env.newClient();
    await secondTab.initialize();
    const outcomes = await Promise.allSettled([
      env.client.saveHealth({ ...input, note: '窗口一' }, saved.id, 1),
      secondTab.saveHealth({ ...input, note: '窗口二' }, saved.id, 1),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const pending = await env.client.database.outbox.where('userId').equals(ownerId).toArray();
    expect(pending).toHaveLength(2);
    env.online();
    await Promise.all([env.client.syncNow(), secondTab.syncNow()]);
    expect(env.snapshot.healthRecords[0].version).toBe(2);
    expect(['窗口一', '窗口二']).toContain(env.snapshot.healthRecords[0].note);
  });
  it('does not overwrite an edit created while its predecessor is inflight', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    const saved = await env.client.saveHealth(input);
    env.beforePush(async () => {
      await env.client.saveHealth({ ...input, note: '请求过程中修改' }, saved.id, 1);
    });
    env.online();
    await env.client.syncNow();
    expect(env.snapshot.healthRecords[0].note).toBe('请求过程中修改');
    expect(env.snapshot.healthRecords[0].version).toBe(2);
    expect(env.client.state.pendingCount).toBe(0);
  });
  it('quarantines old operations after a restore epoch changes', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    env.snapshot.epoch = 'restored';
    env.currentSession.epoch = 'restored';
    env.online();
    await env.client.syncNow();
    expect(env.operations).toHaveLength(0);
    expect(env.client.state.snapshot?.healthRecords).toHaveLength(0);
    expect(env.client.state.conflicts[0].kind).toBe('epoch');
    await expect(
      env.client.resolveConflict(env.client.state.conflicts[0].operationId, 'local'),
    ).rejects.toThrow('不能自动重放');
  });
  it('purges unauthorized cached data and pending care records on permission revocation', async () => {
    const env = setup();
    env.snapshot.grants = [{ ownerId: otherId, granteeId: ownerId, grant: 'care' }];
    env.online();
    await env.client.initialize();
    env.offline();
    await env.client.saveHealth({ ...input, ownerId: otherId });
    expect(env.client.state.snapshot?.healthRecords).toHaveLength(1);
    env.snapshot.grants = [];
    env.online();
    await env.client.syncNow();
    expect(env.client.state.snapshot?.healthRecords).toHaveLength(0);
    expect(env.client.state.pendingCount).toBe(0);
    expect(env.operations).toHaveLength(0);
  });
  it('does not let ordinary caregivers modify another member record', async () => {
    const env = setup();
    env.snapshot.grants = [{ ownerId: otherId, granteeId: ownerId, grant: 'care' }];
    env.online();
    await env.client.initialize();
    env.offline();
    const created = await env.client.saveHealth({ ...input, ownerId: otherId });
    await expect(
      env.client.saveHealth({ ...input, ownerId: otherId }, created.id, 1),
    ).rejects.toThrow('权限');
  });
  it('preserves an expired account queue without exposing it to another account', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    env.online();
    env.expire();
    await env.client.syncNow();
    expect(env.client.state.session).toBeNull();
    expect(env.client.state.snapshot).toBeNull();
    env.offline();
    await env.client.acceptSession({ ...session, user: { ...session.user, id: otherId } });
    expect(env.client.state.pendingCount).toBe(0);
    expect(env.client.state.snapshot?.healthRecords).toHaveLength(0);
    await env.client.acceptSession(session);
    expect(env.client.state.pendingCount).toBe(1);
    expect(env.client.state.snapshot?.healthRecords).toHaveLength(1);
  });
  it('stops uploading when the verified session reports a disabled account', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    env.currentSession.user.active = false;
    env.online();
    await env.client.syncNow();
    expect(env.operations).toHaveLength(0);
    expect(env.client.state.session).toBeNull();
    expect(env.client.state.snapshot).toBeNull();
    expect(env.client.state.conflicts).toHaveLength(0);
    expect(await env.client.database.metadata.get('currentUser')).toBeUndefined();
    await expect(env.client.saveHealth(input)).rejects.toThrow('请先登录');
  });
  it('does not restart an expired account offline from a cached workspace', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    await env.client.saveHealth(input);
    env.online();
    env.expire();
    await env.client.syncNow();
    env.offline();
    const reopened = env.newClient();
    await reopened.initialize();
    expect(reopened.state.session).toBeNull();
    expect(reopened.state.snapshot).toBeNull();
    expect(reopened.state.pendingCount).toBe(0);
    expect(await reopened.database.outbox.where('userId').equals(ownerId).count()).toBe(1);
  });
  it('syncs soft deletion and restoration without resurrecting an old value', async () => {
    const env = setup();
    await env.client.acceptSession(session);
    const created = await env.client.saveHealth(input);
    await env.client.deleteRecord('health', created.id, 1);
    env.online();
    await env.client.syncNow();
    expect(env.snapshot.healthRecords[0].deletedAt).not.toBeNull();
    env.offline();
    await env.client.restoreRecord('health', created.id, 2);
    env.online();
    await env.client.syncNow();
    expect(env.snapshot.healthRecords[0].deletedAt).toBeNull();
    expect(env.snapshot.healthRecords[0].version).toBe(3);
  });
});
