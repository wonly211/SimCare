import { Hono } from 'hono';
import { z } from 'zod';
import {
  beijingNow,
  canCreateHealth,
  canEditOwned,
  canViewHealth,
  dateSchema,
  healthInputSchema,
  medicationInputSchema,
  todayMedication,
  type Grant,
  type HealthInput,
  type HealthRecord,
  type Medication,
  type MedicationInput,
  type Member,
  type SyncOperation,
  type SyncResult,
  type SyncSnapshot,
} from '@simcare/shared';
import {
  activeCheck,
  apiError,
  atomic,
  check,
  fail,
  getMember,
  hash,
  memberFrom,
  memberSql,
  ok,
  revisionBump,
  type AppContext,
  type AppEnv,
  type MemberRow,
} from './core';
import { grants } from './members';

export type Resource = 'health' | 'medication';
export interface RecordRow {
  id: string;
  owner_id: string;
  data: string;
  version: number;
  recorded_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  schedules?: string;
}
const tables = { health: 'health_records', medication: 'medications' } as const;
export function recordFrom(row: RecordRow, resource: Resource): HealthRecord | Medication {
  const data = JSON.parse(row.data) as HealthInput | MedicationInput;
  if (resource === 'medication')
    (data as MedicationInput).schedules = JSON.parse(row.schedules ?? '[]');
  return {
    ...data,
    ownerId: row.owner_id,
    id: row.id,
    version: row.version,
    recordedBy: row.recorded_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
function selectSql(resource: Resource) {
  return resource === 'health'
    ? 'SELECT r.* FROM health_records r'
    : "SELECT r.*,COALESCE((SELECT json_group_array(json(s.data)) FROM medication_schedules s WHERE s.medication_id=r.id),'[]') AS schedules FROM medications r";
}
export async function readRecord(db: D1Database, resource: Resource, id: string) {
  const row = await db
    .prepare(`${selectSql(resource)} WHERE r.id=?`)
    .bind(id)
    .first<RecordRow>();
  return row ? recordFrom(row, resource) : null;
}
export async function allRecords(db: D1Database, resource: Resource) {
  const rows = await db.prepare(selectSql(resource)).all<RecordRow>();
  return rows.results.map((row) => recordFrom(row, resource));
}
const operationSchema = z
  .object({
    operationId: z.string().uuid(),
    epoch: z.string().min(1).max(100),
    resource: z.enum(['health', 'medication']),
    recordId: z.string().uuid(),
    baseVersion: z.number().int().min(0),
    action: z.enum(['upsert', 'delete', 'restore']),
    data: z.unknown().optional(),
  })
  .strict();
function permitted(
  actor: Member,
  owner: string,
  resource: Resource,
  existing: boolean,
  permissions: Grant[],
) {
  return resource === 'health' && !existing
    ? canCreateHealth(actor, owner, permissions)
    : canEditOwned(actor, owner);
}
function permissionCheck(
  db: D1Database,
  actor: Member,
  owner: string,
  resource: Resource,
  existing: boolean,
) {
  return check(
    db,
    `EXISTS(SELECT 1 FROM users u JOIN household_members m ON m.user_id=u.id WHERE u.id=? AND u.active=1 AND m.active=1 AND (u.id=? OR m.role='admin' OR u.system_role='system_admin' ${resource === 'health' && !existing ? "OR EXISTS(SELECT 1 FROM member_permissions p WHERE p.owner_id=? AND p.grantee_id=u.id AND p.permission='care')" : ''}))`,
    resource === 'health' && !existing ? [actor.id, owner, owner] : [actor.id, owner],
  );
}
export async function applyOperation(context: AppContext, raw: unknown): Promise<SyncResult> {
  let operation: SyncOperation | undefined;
  try {
    operation = operationSchema.parse(raw) as SyncOperation;
    const { resource, recordId, operationId } = operation;
    const db = context.env.DB;
    const actor = context.get('actor');
    const state = await db
      .prepare('SELECT epoch FROM system_settings WHERE id=1')
      .first<{ epoch: string }>();
    if (operation.epoch !== state?.epoch)
      fail('EPOCH_CHANGED', '系统已恢复备份，请保留本地内容并重新同步', 409);
    const current = await readRecord(db, resource, recordId);
    const input =
      operation.action === 'upsert'
        ? resource === 'health'
          ? healthInputSchema.parse(operation.data)
          : medicationInputSchema.parse(operation.data)
        : undefined;
    const owner = current?.ownerId ?? input?.ownerId;
    if (!owner || !(await getMember(db, owner))) fail('NOT_FOUND', '记录或成员不存在', 404);
    if (current && input?.ownerId && current.ownerId !== input.ownerId)
      fail('OWNER_IMMUTABLE', '记录所属成员不可更改');
    const permissions = await grants(db);
    const editingExisting = operation.action !== 'upsert' || operation.baseVersion !== 0;
    if (!permitted(actor, owner!, resource, editingExisting, permissions))
      fail('FORBIDDEN', '无权修改此成员的记录', 403);
    const payloadHash = await hash(JSON.stringify(operation));
    const saved = await db
      .prepare('SELECT user_id,payload_hash,result FROM sync_operations WHERE operation_id=?')
      .bind(operationId)
      .first<{ user_id: string; payload_hash: string; result: string }>();
    if (saved) {
      if (saved.user_id !== actor.id || saved.payload_hash !== payloadHash)
        fail('IDEMPOTENCY_MISMATCH', '操作标识已用于其他请求', 409);
      return JSON.parse(saved.result) as SyncResult;
    }
    if ((current?.version ?? 0) !== operation.baseVersion)
      return {
        operationId,
        status: 'conflict',
        ...(current ? { record: current } : {}),
        error: { code: 'VERSION_CONFLICT', message: '记录已由其他设备修改，请确认两个版本' },
      };
    if (!current && operation.action !== 'upsert') fail('NOT_FOUND', '记录不存在', 404);
    if (current?.deletedAt && operation.action === 'upsert')
      fail('RECORD_DELETED', '记录已删除，请先恢复', 409);
    if (operation.action === 'restore' && !current?.deletedAt)
      fail('NOT_DELETED', '记录未删除', 409);
    const now = beijingNow();
    const record = {
      ...(input ?? current!),
      id: recordId,
      version: (current?.version ?? 0) + 1,
      recordedBy: current?.recordedBy ?? actor.id,
      updatedBy: actor.id,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      deletedAt: operation.action === 'delete' ? now : null,
    } as HealthRecord | Medication;
    const result: SyncResult = { operationId, status: 'applied', record };
    const serialized =
      resource === 'health'
        ? JSON.stringify(input ?? healthInputSchema.parse(extractInput(record, resource)))
        : JSON.stringify(extractInput(record, resource), (key, value: unknown) =>
            key === 'schedules' ? undefined : value,
          );
    const statements = [
      activeCheck(db, actor.id),
      permissionCheck(db, actor, owner!, resource, editingExisting),
      check(db, '(SELECT epoch FROM system_settings WHERE id=1)=?', [operation.epoch]),
    ];
    if (current) {
      statements.push(
        db
          .prepare(
            `UPDATE ${tables[resource]} SET data=?,version=?,updated_by=?,updated_at=?,deleted_at=? WHERE id=? AND version=?`,
          )
          .bind(
            serialized,
            record.version,
            actor.id,
            now,
            record.deletedAt,
            recordId,
            current.version,
          ),
        check(db, 'changes()=1'),
      );
    } else
      statements.push(
        db
          .prepare(
            `INSERT INTO ${tables[resource]}(id,owner_id,data,version,recorded_by,updated_by,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .bind(recordId, owner!, serialized, 1, actor.id, actor.id, now, now, null),
      );
    if (resource === 'medication') {
      statements.push(
        db.prepare('DELETE FROM medication_schedules WHERE medication_id=?').bind(recordId),
      );
      for (const schedule of (record as Medication).schedules)
        statements.push(
          db
            .prepare('INSERT INTO medication_schedules(id,medication_id,data) VALUES (?,?,?)')
            .bind(schedule.id, recordId, JSON.stringify(schedule)),
        );
    }
    statements.push(
      db
        .prepare(
          'INSERT INTO record_revisions(id,resource,record_id,version,data,actor_id,created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          resource,
          recordId,
          record.version,
          JSON.stringify(record),
          actor.id,
          now,
        ),
      db
        .prepare(
          'INSERT INTO sync_operations(operation_id,user_id,payload_hash,result,created_at) VALUES (?,?,?,?,?)',
        )
        .bind(operationId, actor.id, payloadHash, JSON.stringify(result), now),
      revisionBump(db),
    );
    try {
      await atomic(db, statements);
    } catch {
      const latestActor = await getMember(db, actor.id);
      if (
        !latestActor ||
        !permitted(latestActor, owner!, resource, editingExisting, await grants(db))
      )
        fail('FORBIDDEN', '权限已变化，操作未同步', 403);
      const replay = await db
        .prepare('SELECT user_id,payload_hash,result FROM sync_operations WHERE operation_id=?')
        .bind(operationId)
        .first<{ user_id: string; payload_hash: string; result: string }>();
      if (replay?.user_id === actor.id && replay.payload_hash === payloadHash)
        return JSON.parse(replay.result) as SyncResult;
      const latest = await readRecord(db, resource, recordId);
      return {
        operationId,
        status: 'conflict',
        ...(latest ? { record: latest } : {}),
        error: { code: 'VERSION_CONFLICT', message: '记录版本或关联数据已变化，操作未写入' },
      };
    }
    return result;
  } catch (error) {
    return {
      operationId:
        operation?.operationId ??
        (typeof raw === 'object' &&
        raw &&
        'operationId' in raw &&
        typeof raw.operationId === 'string'
          ? raw.operationId
          : ''),
      status: 'rejected',
      error:
        error instanceof z.ZodError
          ? { code: 'VALIDATION', message: '记录字段无效', details: error.issues }
          : apiError(error),
    };
  }
}
function extractInput(record: HealthRecord | Medication, resource: Resource) {
  const { id, version, recordedBy, updatedBy, createdAt, updatedAt, deletedAt, ...data } = record;
  void id;
  void version;
  void recordedBy;
  void updatedBy;
  void createdAt;
  void updatedAt;
  void deletedAt;
  return resource === 'health' ? healthInputSchema.parse(data) : medicationInputSchema.parse(data);
}
export const sync = new Hono<AppEnv>();
sync.post('/push', async (context) => {
  const { operations } = z
    .object({ operations: z.array(z.unknown()).min(1).max(1) })
    .parse(await context.req.json());
  const results: SyncResult[] = [];
  for (const operation of operations) results.push(await applyOperation(context, operation));
  return ok(context, results);
});
sync.get('/pull', async (context) => {
  const db = context.env.DB;
  // One transaction keeps the revision, authorization and records in the same snapshot.
  const results = await db.batch([
    db.prepare('SELECT epoch,revision FROM system_settings WHERE id=1'),
    db.prepare(memberSql),
    db.prepare(
      'SELECT owner_id AS ownerId,grantee_id AS granteeId,permission AS "grant" FROM member_permissions',
    ),
    db.prepare(selectSql('health')),
    db.prepare(selectSql('medication')),
  ]);
  const state = results[0]!.results[0] as { epoch: string; revision: number };
  const members = (results[1]!.results as unknown as MemberRow[]).map(memberFrom);
  const actor = members.find((member) => member.id === context.get('actor').id);
  if (!actor?.active) return fail('UNAUTHENTICATED', '账户已停用', 401);
  const permissions = results[2]!.results as unknown as Grant[];
  const snapshot: SyncSnapshot = {
    epoch: state.epoch,
    revision: String(state.revision),
    members,
    grants: permissions.filter(
      (item) =>
        actor.householdRole === 'admin' || item.ownerId === actor.id || item.granteeId === actor.id,
    ),
    healthRecords: (results[3]!.results as unknown as RecordRow[])
      .map((row) => recordFrom(row, 'health') as HealthRecord)
      .filter((item) => canViewHealth(actor, item.ownerId, permissions)),
    medications: (results[4]!.results as unknown as RecordRow[]).map(
      (row) => recordFrom(row, 'medication') as Medication,
    ),
  };
  return ok(context, snapshot);
});
export const records = new Hono<AppEnv>();
records.get('/medications/today', async (context) => {
  const date = context.req.query('date');
  if (date) dateSchema.parse(date);
  const ownerId = context.req.query('ownerId');
  if (ownerId) z.string().uuid().parse(ownerId);
  const medications = ((await allRecords(context.env.DB, 'medication')) as Medication[]).filter(
    (item) => !ownerId || item.ownerId === ownerId,
  );
  return ok(context, todayMedication(medications, date));
});
for (const [path, resource] of [
  ['health-records', 'health'],
  ['medications', 'medication'],
] as const)
  records.get(`/${path}/:id/history`, async (context) => {
    const record = await readRecord(context.env.DB, resource, context.req.param('id'));
    if (!record) fail('NOT_FOUND', '记录不存在', 404);
    if (
      resource === 'health' &&
      !canViewHealth(context.get('actor'), record!.ownerId, await grants(context.env.DB))
    )
      fail('FORBIDDEN', '无权查看记录', 403);
    const rows = await context.env.DB.prepare(
      'SELECT * FROM record_revisions WHERE resource=? AND record_id=? ORDER BY version DESC',
    )
      .bind(resource, record!.id)
      .all<{
        id: string;
        record_id: string;
        version: number;
        data: string;
        actor_id: string;
        created_at: string;
      }>();
    return ok(
      context,
      rows.results.map((row) => ({
        id: row.id,
        recordId: row.record_id,
        version: row.version,
        data: JSON.parse(row.data),
        actorId: row.actor_id,
        createdAt: row.created_at,
      })),
    );
  });
