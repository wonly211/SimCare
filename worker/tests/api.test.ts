import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  beijingNow,
  type BackupData,
  type HealthInput,
  type MedicationInput,
  type Session,
  type SyncOperation,
  type SyncResult,
  type SyncSnapshot,
} from '@simcare/shared';
import { app } from '../src/index';
import { hash, type Bindings } from '../src/core';
import { readRecord } from '../src/records';

const origin = 'https://simcare.example.test';
const users = {
  system: '10000000-0000-4000-8000-000000000001',
  admin: '10000000-0000-4000-8000-000000000002',
  owner: '10000000-0000-4000-8000-000000000003',
  care: '10000000-0000-4000-8000-000000000004',
};
const householdId = '20000000-0000-4000-8000-000000000001';
const epoch = '30000000-0000-4000-8000-000000000001';
let runtime: Miniflare;
let db: D1Database;
let env: Bindings;
type Result<T> = { success: boolean; data: T; error: { code: string; message: string } | null };
async function request<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  actor?: keyof typeof users,
  requestOrigin = origin,
) {
  const headers: Record<string, string> = { Origin: requestOrigin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (actor) headers.Cookie = `simcare_session=test-${actor}`;
  const response = await app.request(
    `${origin}/api/v1${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  return { response, body: (await response.json()) as Result<T> };
}
async function clear() {
  for (const table of [
    'login_requests',
    'auth_rate_limits',
    'restore_previews',
    'restore_snapshots',
    'atomic_checks',
    'sync_operations',
    'record_revisions',
    'medication_schedules',
    'medications',
    'health_records',
    'member_permissions',
    'qr_logins',
    'recovery_tickets',
    'recovery_codes',
    'challenges',
    'invitations',
    'sessions',
    'credentials',
    'household_members',
    'users',
    'system_settings',
    'household',
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare("INSERT INTO system_settings(id,epoch) VALUES(1,'uninitialized')").run();
}
async function seed() {
  await clear();
  const now = beijingNow();
  await db
    .prepare('INSERT INTO household(id,name,created_at)VALUES(?,?,?)')
    .bind(householdId, '测试家庭', now)
    .run();
  await db
    .prepare('UPDATE system_settings SET initialized=1,household_id=?,epoch=? WHERE id=1')
    .bind(householdId, epoch)
    .run();
  for (const [name, userId] of Object.entries(users)) {
    await db
      .prepare(
        'INSERT INTO users(id,nickname,system_role,active,created_at,phone)VALUES(?,?,?,1,?,?)',
      )
      .bind(
        userId,
        name,
        name === 'system' ? 'system_admin' : null,
        now,
        '1380000000' + Object.keys(users).indexOf(name),
      )
      .run();
    await db
      .prepare('INSERT INTO household_members(user_id,household_id,role,active)VALUES(?,?,?,1)')
      .bind(userId, householdId, ['system', 'admin'].includes(name) ? 'admin' : 'member')
      .run();
    await db
      .prepare(
        'INSERT INTO sessions(token_hash,user_id,created_at,expires_at,verified_at)VALUES(?,?,?,?,?)',
      )
      .bind(
        await hash(`test-${name}`),
        userId,
        now,
        beijingNow(new Date(Date.now() + 86400000)),
        now,
      )
      .run();
  }
  await db
    .prepare(
      "INSERT INTO credentials(id,user_id,public_key,counter,device_type,backed_up,transports,name,created_at)VALUES(?,?,?,0,'singleDevice',0,'[]','fixture',?)",
    )
    .bind('fixture-credential', users.system, btoa('test-public-key'), now)
    .run();
}
function health(ownerId = users.owner): HealthInput {
  return {
    ownerId,
    measuredAt: beijingNow(),
    systolic: 120,
    diastolic: 80,
    pulse: 70,
    oxygen: null,
    temperature: null,
    posture: 'sitting',
    arm: 'left',
    note: '',
  };
}
function medication(ownerId = users.owner): MedicationInput {
  return {
    ownerId,
    name: '测试药物',
    specification: '测试规格',
    form: '片剂',
    route: '口服',
    reason: '',
    note: '',
    startDate: '2026-01-01',
    endDate: null,
    status: 'active',
    schedules: [
      {
        id: crypto.randomUUID(),
        period: 'morning',
        time: null,
        dose: '1',
        unit: '片',
        meal: 'after',
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      },
    ],
  };
}
function operation(
  data: HealthInput | MedicationInput = health(),
  resource: 'health' | 'medication' = 'health',
): SyncOperation {
  return {
    operationId: crypto.randomUUID(),
    epoch,
    resource,
    recordId: crypto.randomUUID(),
    baseVersion: 0,
    action: 'upsert',
    data,
  };
}
async function push(operations: SyncOperation[], actor: keyof typeof users = 'owner') {
  return request<SyncResult[]>('POST', '/sync/push', { operations }, actor);
}
beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    compatibilityDate: '2026-07-22',
    d1Databases: ['DB'],
  });
  db = (await runtime.getD1Database('DB')) as unknown as D1Database;
  for (const file of (await readdir('db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const source = await readFile(`db/migrations/${file}`, 'utf8');
    for (const statement of source
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  env = {
    DB: db,
    APP_ORIGIN: origin,
    INIT_KEY: 'integration-test-init-key',
    ENVIRONMENT: 'test',
  };
});
beforeEach(seed);
afterAll(async () => {
  await runtime?.dispose();
});

describe('认证、邀请与权限', () => {
  it('拒绝无会话读写和跨站写入', async () => {
    expect((await request('GET', '/sync/pull')).response.status).toBe(401);
    expect(
      (
        await request(
          'POST',
          '/sync/push',
          { operations: [operation()] },
          'owner',
          'https://evil.test',
        )
      ).response.status,
    ).toBe(403);
    expect(
      (await request('POST', '/invitations', { role: 'member' }, 'owner')).response.status,
    ).toBe(403);
  });
  it('管理员不可被普通成员限制，只有系统管理员管理角色', async () => {
    expect(
      (await request('PUT', `/permissions/${users.admin}`, { grant: 'none' }, 'owner')).response
        .status,
    ).toBe(400);
    expect(
      (await request('PATCH', `/members/${users.owner}`, { householdRole: 'admin' }, 'admin'))
        .response.status,
    ).toBe(403);
    expect(
      (await request('PATCH', `/members/${users.owner}`, { householdRole: 'admin' }, 'system'))
        .response.status,
    ).toBe(200);
    expect(
      (await request('PATCH', `/members/${users.system}`, { active: false }, 'system')).response
        .status,
    ).toBe(403);
    expect(
      (await request('POST', `/members/${users.system}/recovery`, {}, 'admin')).response.status,
    ).toBe(404);
  });
});

describe('健康、用药和离线同步', () => {
  it('健康记录幂等、乐观版本、修订和软删除恢复', async () => {
    const create = operation();
    const first = await push([create]);
    expect(first.body.data[0]!.status).toBe('applied');
    expect((await push([create])).body.data[0]!.status).toBe('applied');
    const edit = {
      ...create,
      operationId: crypto.randomUUID(),
      baseVersion: 1,
      data: { ...health(), systolic: 125 },
    };
    expect((await push([edit])).body.data[0]!.record?.version).toBe(2);
    expect((await push([{ ...edit, operationId: crypto.randomUUID() }])).body.data[0]!.status).toBe(
      'conflict',
    );
    expect(
      (
        await push([
          {
            ...create,
            operationId: crypto.randomUUID(),
            baseVersion: 2,
            action: 'delete',
            data: undefined,
          },
        ])
      ).body.data[0]!.record?.deletedAt,
    ).not.toBeNull();
    expect(
      (
        await push([
          {
            ...create,
            operationId: crypto.randomUUID(),
            baseVersion: 3,
            action: 'restore',
            data: undefined,
          },
        ])
      ).body.data[0]!.record?.version,
    ).toBe(4);
    expect(
      (
        await request<unknown[]>(
          'GET',
          `/health-records/${create.recordId}/history`,
          undefined,
          'owner',
        )
      ).body.data,
    ).toHaveLength(4);
  });
  it('普通照护者可代录并重试但不能修改，撤权后不得重放获取数据', async () => {
    await request('PUT', `/permissions/${users.care}`, { grant: 'care' }, 'owner');
    const create = operation();
    expect((await push([create], 'care')).body.data[0]!.record?.recordedBy).toBe(users.care);
    expect((await push([create], 'care')).body.data[0]!.status).toBe('applied');
    expect(
      (await push([{ ...create, operationId: crypto.randomUUID(), baseVersion: 1 }], 'care')).body
        .data[0]!.error?.code,
    ).toBe('FORBIDDEN');
    await request('PUT', `/permissions/${users.care}`, { grant: 'none' }, 'owner');
    expect((await push([create], 'care')).body.data[0]!.error?.code).toBe('FORBIDDEN');
  });
  it('快照和历史只暴露授权健康记录，用药仍家庭可见', async () => {
    const create = operation();
    await push([create]);
    await push([operation(medication(), 'medication')]);
    const snapshot = await request<SyncSnapshot>('GET', '/sync/pull', undefined, 'care');
    expect(snapshot.body.data.healthRecords).toHaveLength(0);
    expect(snapshot.body.data.medications).toHaveLength(1);
    expect(
      (await request('GET', `/health-records/${create.recordId}/history`, undefined, 'care'))
        .response.status,
    ).toBe(403);
    expect(
      (await request<SyncSnapshot>('GET', '/sync/pull', undefined, 'admin')).body.data
        .healthRecords,
    ).toHaveLength(1);
  });
  it('修改归属、相同幂等键不同数据和旧epoch均被拒绝', async () => {
    const create = operation();
    await push([create]);
    expect(
      (await push([{ ...create, data: { ...health(), systolic: 130 } }])).body.data[0]!.error?.code,
    ).toBe('IDEMPOTENCY_MISMATCH');
    expect(
      (
        await push(
          [
            {
              ...create,
              operationId: crypto.randomUUID(),
              baseVersion: 1,
              data: health(users.care),
            },
          ],
          'admin',
        )
      ).body.data[0]!.error?.code,
    ).toBe('OWNER_IMMUTABLE');
    expect((await push([{ ...operation(), epoch: 'old-epoch' }])).body.data[0]!.error?.code).toBe(
      'EPOCH_CHANGED',
    );
  });
  it('普通照护权限不扩大为编辑用药权限', async () => {
    await request('PUT', `/permissions/${users.care}`, { grant: 'care' }, 'owner');
    expect(
      (await push([operation(medication(), 'medication')], 'care')).body.data[0]!.error?.code,
    ).toBe('FORBIDDEN');
    expect(
      (await push([operation(medication(), 'medication')], 'admin')).body.data[0]!.status,
    ).toBe('applied');
  });
  it('重复计划标识使D1事务完整回滚，不留下药物或历史', async () => {
    const data = medication();
    data.schedules.push({ ...data.schedules[0]! });
    const create = operation(data, 'medication');
    expect((await push([create])).body.data[0]!.status).toBe('conflict');
    expect(await readRecord(db, 'medication', create.recordId)).toBeNull();
    expect(
      (await db
        .prepare('SELECT COUNT(*) AS count FROM record_revisions')
        .first<{ count: number }>())!.count,
    ).toBe(0);
  });
  it('停用账户立即失去会话和同步权限', async () => {
    expect(
      (await request('PATCH', `/members/${users.owner}`, { active: false }, 'admin')).response
        .status,
    ).toBe(200);
    expect((await push([operation()])).response.status).toBe(401);
  });
});

describe('备份恢复', () => {
  it('超限备份在预览阶段拒绝且不改变业务状态', async () => {
    const backup = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    backup.tables.users![0]!.nickname = 'x'.repeat(800000);
    const result = await request(
      'POST',
      '/backups/preview',
      { backup, mode: 'overwrite' },
      'system',
    );
    expect(result.body.error?.code).toBe('BACKUP_TOO_LARGE');
    expect(
      (await db
        .prepare('SELECT COUNT(*) AS count FROM restore_previews')
        .first<{ count: number }>())!.count,
    ).toBe(0);
    expect((await request('GET', '/auth/session', undefined, 'system')).response.status).toBe(200);
  });
  it('拒绝历史代录人和所属记录不一致的备份', async () => {
    await push([operation()]);
    const backup = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    const row = backup.tables.record_revisions![0]!;
    row.data = JSON.stringify({ ...JSON.parse(String(row.data)), recordedBy: users.care });
    expect(
      (await request('POST', '/backups/preview', { backup, mode: 'overwrite' }, 'system')).body
        .error?.code,
    ).toBe('BACKUP_INVALID');
  });
  it('合并计划标识冲突时不导入残缺药物', async () => {
    await push([operation(medication(), 'medication')]);
    const backup = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    const newId = crypto.randomUUID();
    backup.tables.medications![0]!.id = newId;
    backup.tables.medication_schedules![0]!.medication_id = newId;
    const revision = backup.tables.record_revisions![0]!;
    revision.id = crypto.randomUUID();
    revision.record_id = newId;
    revision.data = JSON.stringify({ ...JSON.parse(String(revision.data)), id: newId });
    const preview = await request<{ previewId: string; conflicts: { table: string }[] }>(
      'POST',
      '/backups/preview',
      { backup, mode: 'merge' },
      'system',
    );
    expect(preview.response.status).toBe(200);
    expect(preview.body.data.conflicts.some((item) => item.table === 'medications')).toBe(true);
    expect(
      (
        await request(
          'POST',
          '/backups/restore',
          { previewId: preview.body.data.previewId },
          'system',
        )
      ).response.status,
    ).toBe(200);
    expect(await readRecord(db, 'medication', newId)).toBeNull();
    expect(
      (await db.prepare('SELECT COUNT(*) AS count FROM medications').first<{ count: number }>())!
        .count,
    ).toBe(1);
  });
  it('只允许系统管理员导出，排除会话和临时认证秘密', async () => {
    expect((await request('GET', '/backups/export', undefined, 'admin')).response.status).toBe(403);
    const backup = await request<BackupData>('GET', '/backups/export', undefined, 'system');
    expect(backup.response.status).toBe(200);
    expect(backup.body.data.tables).not.toHaveProperty('sessions');
    expect(backup.body.data.tables).not.toHaveProperty('challenges');
    expect(JSON.stringify(backup.body.data)).not.toContain(env.INIT_KEY);
  });
  it('覆盖恢复保留恢复前快照并使旧会话及epoch失效', async () => {
    const original = operation();
    await push([original]);
    const backup = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    await push([operation()]);
    const preview = await request<{ previewId: string }>(
      'POST',
      '/backups/preview',
      { backup, mode: 'overwrite' },
      'system',
    );
    expect(preview.response.status).toBe(200);
    const restored = await request<{ epoch: string }>(
      'POST',
      '/backups/restore',
      { previewId: preview.body.data.previewId },
      'system',
    );
    expect(restored.response.status).toBe(200);
    expect(restored.body.data.epoch).not.toBe(epoch);
    expect(
      (await db.prepare('SELECT COUNT(*) AS count FROM health_records').first<{ count: number }>())!
        .count,
    ).toBe(1);
    expect(
      (await db
        .prepare('SELECT COUNT(*) AS count FROM restore_snapshots')
        .first<{ count: number }>())!.count,
    ).toBe(1);
    expect((await request('GET', '/auth/session', undefined, 'system')).response.status).toBe(401);
  });
  it('合并保留冲突版本且不会从旧备份恢复角色权限', async () => {
    const original = operation();
    await push([original]);
    const backup = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    backup.tables.household_members!.find((row) => row.user_id === users.owner)!.role = 'admin';
    await push([
      {
        ...original,
        operationId: crypto.randomUUID(),
        baseVersion: 1,
        data: { ...health(), systolic: 130 },
      },
    ]);
    const preview = await request<{ previewId: string; conflicts: unknown[] }>(
      'POST',
      '/backups/preview',
      { backup, mode: 'merge' },
      'system',
    );
    expect(preview.response.status).toBe(200);
    expect(preview.body.data.conflicts.length).toBeGreaterThan(0);
    expect(
      (
        await request(
          'POST',
          '/backups/restore',
          { previewId: preview.body.data.previewId },
          'system',
        )
      ).response.status,
    ).toBe(200);
    expect((await readRecord(db, 'health', original.recordId))!.version).toBe(2);
    expect(
      (await db
        .prepare('SELECT role FROM household_members WHERE user_id=?')
        .bind(users.owner)
        .first<{ role: string }>())!.role,
    ).toBe('member');
  });
  it('预览后业务发生改变时原子拒绝恢复', async () => {
    const backup = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    const preview = await request<{ previewId: string }>(
      'POST',
      '/backups/preview',
      { backup, mode: 'overwrite' },
      'system',
    );
    await push([operation()]);
    expect(
      (
        await request(
          'POST',
          '/backups/restore',
          { previewId: preview.body.data.previewId },
          'system',
        )
      ).response.status,
    ).toBe(409);
    expect(
      (await db.prepare('SELECT COUNT(*) AS count FROM health_records').first<{ count: number }>())!
        .count,
    ).toBe(1);
    expect(
      (await db
        .prepare('SELECT COUNT(*) AS count FROM restore_snapshots')
        .first<{ count: number }>())!.count,
    ).toBe(0);
  });
  it('拒绝未知表和旧 Passkey 版本备份', async () => {
    const original = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    const broken = structuredClone(original);
    broken.tables.sessions = [];
    expect(
      (await request('POST', '/backups/preview', { backup: broken, mode: 'overwrite' }, 'system'))
        .response.status,
    ).toBe(400);
    const wrongRp = structuredClone(original);
    (wrongRp as unknown as { version: number }).version = 1;
    expect(
      (await request('POST', '/backups/preview', { backup: wrongRp, mode: 'overwrite' }, 'system'))
        .response.status,
    ).toBe(400);
  });
});

describe('手机号与设备审批', () => {
  type Ticket = { id: string; pollToken: string; expiresAt: string };
  const phones = {
    system: '13800000000',
    admin: '13800000001',
    owner: '13800000002',
    care: '13800000003',
  };
  const key = 'integration-test-init-key';
  async function ticket(phone = phones.owner, extra: Record<string, string> = {}) {
    const result = await request<Ticket>('POST', '/auth/requests', {
      phone,
      deviceName: '测试手机',
      ...extra,
    });
    expect(result.response.status).toBe(200);
    return result.body.data;
  }
  async function decision(item: Ticket, actor: keyof typeof users = 'admin', approve = true) {
    return request('POST', `/auth/requests/${item.id}/decision`, { approve }, actor);
  }
  async function poll(item: Ticket) {
    return request<{ status: string; session: Session }>('POST', `/auth/requests/${item.id}/poll`, {
      pollToken: item.pollToken,
    });
  }
  it('初始化只成功一次，手机号规范化且 Cookie 保持 180 天', async () => {
    await clear();
    const input = { phone: '+86 13800000000', nickname: '家人', initKey: key, deviceName: '手机' };
    const results = await Promise.all([
      request<Session>('POST', '/auth/initialize', input),
      request<Session>('POST', '/auth/initialize', input),
    ]);
    expect(results.map((x) => x.response.status).sort()).toEqual([200, 409]);
    const success = results.find((x) => x.response.status === 200)!;
    expect(success.body.data.user.phone).toBe(phones.system);
    expect(success.body.data.user.systemRole).toBe('system_admin');
    expect(success.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(success.response.headers.get('set-cookie')).toContain('Max-Age=15552000');
    expect((await db.prepare('SELECT count(*) n FROM household').first<{ n: number }>())!.n).toBe(
      1,
    );
  });
  it('缺少或冲突的 init_key 有明确提示', async () => {
    const previous = env.INIT_KEY;
    delete env.INIT_KEY;
    try {
      expect(
        (await request<{ configured: boolean }>('GET', '/auth/status')).body.data.configured,
      ).toBe(false);
      expect(
        (await request('POST', '/auth/admin-recover', { phone: phones.system, initKey: key })).body
          .error?.code,
      ).toBe('SETUP_REQUIRED');
      env.init_key = 'new-key';
      env.INIT_KEY = previous;
      expect((await request('GET', '/auth/status')).body.error?.code).toBe('CONFIG_CONFLICT');
    } finally {
      delete env.init_key;
      env.INIT_KEY = previous;
    }
  });
  it('普通成员不能批准，批准后只能由申请设备领取一次', async () => {
    const item = await ticket();
    expect((await decision(item, 'owner')).response.status).toBe(403);
    expect((await decision(item)).response.status).toBe(200);
    expect(
      (await request('POST', `/auth/requests/${item.id}/poll`, { pollToken: 'x'.repeat(64) }))
        .response.status,
    ).toBe(404);
    const results = await Promise.all([poll(item), poll(item)]);
    expect(results.filter((x) => x.body.data?.session).length).toBe(1);
    expect((await poll(item)).response.headers.get('set-cookie')).toBeNull();
  });
  it('家庭管理员不能批准管理员，系统管理员可批准', async () => {
    const item = await ticket(phones.admin);
    expect((await decision(item, 'admin')).response.status).toBe(403);
    expect((await decision(item, 'system')).response.status).toBe(200);
    expect((await poll(item)).body.data.session.user.id).toBe(users.admin);
  });
  it('审批者降级后不能领取旧批准', async () => {
    const item = await ticket();
    await decision(item);
    await db
      .prepare("UPDATE household_members SET role='member' WHERE user_id=?")
      .bind(users.admin)
      .run();
    expect((await poll(item)).response.status).toBe(409);
    expect(
      (await db
        .prepare("SELECT count(*) n FROM sessions WHERE device_name='测试手机'")
        .first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it('目标停用后不能领取旧批准', async () => {
    const item = await ticket();
    await decision(item);
    await db.prepare('UPDATE users SET active=0 WHERE id=?').bind(users.owner).run();
    expect((await poll(item)).response.status).toBe(409);
  });
  it('拒绝和过期的申请不建立会话', async () => {
    const rejected = await ticket();
    await decision(rejected, 'admin', false);
    expect((await poll(rejected)).body.data.status).toBe('rejected');
    const expired = await ticket();
    await db
      .prepare('UPDATE login_requests SET expires_at=? WHERE id=?')
      .bind(beijingNow(new Date(Date.now() - 60000)), expired.id)
      .run();
    expect((await decision(expired)).response.status).toBe(409);
    expect((await poll(expired)).body.data.status).toBe('expired');
  });
  it('邀请注册需批准，重复手机号和一次性邀请不能并发创建两人', async () => {
    const invite = (
      await request<{ token: string }>('POST', '/invitations', { role: 'member' }, 'admin')
    ).body.data.token;
    const extra = { inviteToken: invite, nickname: '新家人' };
    const a = await ticket('13900000000', extra),
      b = await ticket('+86 13900000000', extra);
    expect(
      (await db
        .prepare('SELECT count(*) n FROM users WHERE phone=?')
        .bind('13900000000')
        .first<{ n: number }>())!.n,
    ).toBe(0);
    const decisions = await Promise.all([decision(a), decision(b)]);
    expect(decisions.map((x) => x.response.status).sort()).toEqual([200, 409]);
    const approved = decisions[0]!.response.status === 200 ? a : b;
    expect((await poll(approved)).body.data.session.user.phone).toBe('13900000000');
  });
  it('审批时重新校验邀请撤销和成员上限', async () => {
    const invite = (
      await request<{ token: string }>('POST', '/invitations', { role: 'member' }, 'admin')
    ).body.data.token;
    const item = await ticket('13900000000', { inviteToken: invite, nickname: '新家人' });
    await db.prepare('UPDATE invitations SET revoked_at=?').bind(beijingNow()).run();
    expect((await decision(item)).response.status).toBe(409);
    await db.prepare('UPDATE invitations SET revoked_at=NULL').run();
    for (let i = 0; i < 6; i++) {
      const id = crypto.randomUUID();
      await db
        .prepare('INSERT INTO users(id,nickname,active,created_at,phone) VALUES(?,?,1,?,?)')
        .bind(id, '测试', beijingNow(), `1390000001${i}`)
        .run();
      await db
        .prepare(
          "INSERT INTO household_members(user_id,household_id,role,active) VALUES(?,?,'member',1)",
        )
        .bind(id, householdId)
        .run();
    }
    expect((await decision(item)).response.status).toBe(409);
    expect((await db.prepare('SELECT count(*) n FROM users').first<{ n: number }>())!.n).toBe(10);
  });
  it('系统管理员仅凭自己的手机号和正确 init_key 恢复', async () => {
    expect(
      (await request('POST', '/auth/admin-recover', { phone: phones.owner, initKey: key })).response
        .status,
    ).toBe(403);
    expect(
      (await request('POST', '/auth/admin-recover', { phone: phones.system, initKey: 'wrong' }))
        .response.status,
    ).toBe(403);
    const result = await request<Session>('POST', '/auth/admin-recover', {
      phone: phones.system,
      initKey: key,
    });
    expect(result.body.data.user.id).toBe(users.system);
    expect((await db.prepare('SELECT count(*) n FROM household').first<{ n: number }>())!.n).toBe(
      1,
    );
  });
  it('每日续期一次且撤销设备后会话失效', async () => {
    const old = beijingNow(new Date(Date.now() - 2 * 86400000));
    await db
      .prepare('UPDATE sessions SET renewed_at=?,device_id=? WHERE user_id=?')
      .bind(old, 'test-device', users.owner)
      .run();
    const refreshed = await Promise.all([
      request('GET', '/auth/session', undefined, 'owner'),
      request('GET', '/auth/session', undefined, 'owner'),
    ]);
    expect(
      refreshed.filter((item) =>
        item.response.headers.get('set-cookie')?.includes('Max-Age=15552000'),
      ),
    ).toHaveLength(1);
    expect(
      (await request('GET', '/auth/session', undefined, 'owner')).response.headers.get(
        'set-cookie',
      ),
    ).toBeNull();
    await request('DELETE', '/auth/devices/test-device', undefined, 'care');
    expect((await request('GET', '/auth/session', undefined, 'owner')).response.status).toBe(200);
    await request('DELETE', '/auth/devices/test-device', undefined, 'owner');
    expect((await request('GET', '/auth/session', undefined, 'owner')).response.status).toBe(401);
  });
  it('当前访问域自动适配且跨站 Origin 被拒绝', async () => {
    const response = await app.request(
      'https://new.example/api/v1/auth/admin-recover',
      {
        method: 'POST',
        headers: { Origin: 'https://new.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phones.system, initKey: key }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(
      (
        await request(
          'POST',
          '/auth/admin-recover',
          { phone: phones.system, initKey: key },
          undefined,
          'https://other.example',
        )
      ).response.status,
    ).toBe(403);
  });
  it('恢复备份后使用当前 init_key 登录，备份不含旧凭据或审批', async () => {
    const backup = (await request<BackupData>('GET', '/backups/export', undefined, 'system')).body
      .data;
    for (const name of ['credentials', 'recovery_codes', 'login_requests', 'sessions'])
      expect(backup.tables).not.toHaveProperty(name);
    const preview = (
      await request<{ previewId: string }>(
        'POST',
        '/backups/preview',
        { backup, mode: 'overwrite' },
        'system',
      )
    ).body.data;
    expect(
      (await request('POST', '/backups/restore', { previewId: preview.previewId }, 'system'))
        .response.status,
    ).toBe(200);
    expect(
      (await request('POST', '/auth/admin-recover', { phone: phones.system, initKey: key }))
        .response.status,
    ).toBe(200);
  });
});
