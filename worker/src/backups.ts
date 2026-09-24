import { Hono } from 'hono';
import { z } from 'zod';
import {
  beijingNow,
  healthInputSchema,
  medicationInputSchema,
  scheduleSchema,
  timestampSchema,
  phoneSchema,
  type BackupData,
} from '@simcare/shared';
import {
  activeCheck,
  admin,
  atomic,
  check,
  fail,
  later,
  ok,
  requireFresh,
  type AppEnv,
} from './core';

const id = z.string().uuid();
const nullableTime = timestampSchema.nullable();
const flag = z.union([z.literal(0), z.literal(1)]);
const recordShape = {
  id,
  owner_id: id,
  data: z.string().max(100000),
  version: z.number().int().positive(),
  recorded_by: id,
  updated_by: id,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: nullableTime,
};
const schemas = {
  household: z
    .object({ id, name: z.string().min(1).max(100), created_at: timestampSchema })
    .strict(),
  system_settings: z
    .object({
      id: z.literal(1),
      initialized: z.literal(1),
      household_id: id,
      epoch: z.string().min(1),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  users: z
    .object({
      id,
      nickname: z.string().min(1).max(80),
      phone: phoneSchema,
      system_role: z.literal('system_admin').nullable(),
      active: flag,
      created_at: timestampSchema,
    })
    .strict(),
  household_members: z
    .object({ user_id: id, household_id: id, role: z.enum(['admin', 'member']), active: flag })
    .strict(),
  member_permissions: z
    .object({ owner_id: id, grantee_id: id, permission: z.enum(['none', 'view', 'care']) })
    .strict(),
  health_records: z.object(recordShape).strict(),
  medications: z.object(recordShape).strict(),
  medication_schedules: z.object({ id, medication_id: id, data: z.string().max(10000) }).strict(),
  record_revisions: z
    .object({
      id,
      resource: z.enum(['health', 'medication']),
      record_id: id,
      version: z.number().int().positive(),
      data: z.string().max(100000),
      actor_id: id,
      created_at: timestampSchema,
    })
    .strict(),
} as const;
type Table = keyof typeof schemas;
type Row = Record<string, unknown>;
const tableNames = Object.keys(schemas) as Table[];
const insertOrder: Table[] = [
  'household',
  'users',
  'household_members',
  'system_settings',
  'member_permissions',
  'health_records',
  'medications',
  'medication_schedules',
  'record_revisions',
];
function key(table: Table, row: Row) {
  return table === 'household_members'
    ? String(row.user_id)
    : table === 'member_permissions'
      ? `${String(row.owner_id)}:${String(row.grantee_id)}`
      : String(row.id);
}
function canonical(row: Row) {
  return JSON.stringify(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)));
}
function boundedJson(value: unknown, limit = 750 * 1024) {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > limit)
    fail('BACKUP_TOO_LARGE', '当前版本原子恢复上限为 750 KiB；超出范围需维护者执行分批迁移');
  return serialized;
}
export async function exportData(db: D1Database): Promise<BackupData> {
  const result = await db.batch(tableNames.map((table) => db.prepare(`SELECT * FROM ${table}`)));
  const tables: BackupData['tables'] = {};
  tableNames.forEach((table, index) => {
    tables[table] = result[index]!.results as Row[];
  });
  return {
    format: 'simcare',
    version: 2,
    createdAt: beijingNow(),
    sourceId: String(tables.household![0]?.id ?? ''),
    tables,
  };
}
function validateBackup(value: unknown): BackupData {
  if ((value as { version?: unknown })?.version !== 2)
    fail('BACKUP_INCOMPATIBLE', '仅支持手机号版本备份，旧 Passkey 备份不能直接恢复');
  boundedJson(value);
  const backup = z
    .object({
      format: z.literal('simcare'),
      version: z.literal(2),
      createdAt: timestampSchema,
      sourceId: id,
      tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
    })
    .strict()
    .parse(value);
  if (Object.keys(backup.tables).some((table) => !tableNames.includes(table as Table)))
    fail('BACKUP_INVALID', '备份包含未知数据表');
  let total = 0;
  for (const table of tableNames) {
    if (!backup.tables[table]) fail('BACKUP_INVALID', `备份缺少 ${table}`);
    backup.tables[table] = backup.tables[table]!.map((row) => schemas[table].parse(row));
    total += backup.tables[table]!.length;
    const ids = new Set(backup.tables[table]!.map((row) => key(table, row)));
    if (ids.size !== backup.tables[table]!.length) fail('BACKUP_INVALID', `${table} 包含重复标识`);
  }
  if (total > 20000)
    fail('BACKUP_TOO_LARGE', '当前原子恢复限额为 20000 行，请联系维护者分阶段迁移');
  const household = backup.tables.household!;
  if (
    household.length !== 1 ||
    household[0]!.id !== backup.sourceId ||
    backup.tables.system_settings!.length !== 1 ||
    backup.tables.system_settings![0]!.household_id !== backup.sourceId
  )
    fail('BACKUP_INVALID', '单家庭关系无效');
  const users = new Map(backup.tables.users!.map((row) => [String(row.id), row]));
  const members = new Map(
    backup.tables.household_members!.map((row) => [String(row.user_id), row]),
  );
  if (users.size !== members.size || [...users.keys()].some((userId) => !members.has(userId)))
    fail('BACKUP_INVALID', '账户和家庭成员关系不完整');
  if (backup.tables.household_members!.filter((row) => row.active === 1).length > 10)
    fail('MEMBER_LIMIT', '家庭有效成员不能超过 10 人');
  const admins = backup.tables.users!.filter((row) => row.system_role === 'system_admin');
  if (
    admins.length !== 1 ||
    admins[0]!.active !== 1 ||
    members.get(String(admins[0]!.id))?.role !== 'admin' ||
    members.get(String(admins[0]!.id))?.active !== 1
  )
    fail('BACKUP_INVALID', '必须保留一个有效系统管理员');
  for (const row of backup.tables.household_members!)
    if (!users.has(String(row.user_id)) || row.household_id !== backup.sourceId)
      fail('BACKUP_INVALID', '家庭成员引用无效');
  const phones = backup.tables.users!.map((row) => row.phone);
  if (new Set(phones).size !== phones.length) fail('BACKUP_INVALID', '备份包含重复手机号');
  for (const row of backup.tables.member_permissions!)
    if (
      !users.has(String(row.owner_id)) ||
      !users.has(String(row.grantee_id)) ||
      row.owner_id === row.grantee_id
    )
      fail('BACKUP_INVALID', '授权引用无效');
  const medicationIds = new Set(backup.tables.medications!.map((row) => row.id));
  for (const row of backup.tables.medication_schedules!) {
    const schedule = scheduleSchema.parse(JSON.parse(String(row.data)));
    if (schedule.id !== row.id || !medicationIds.has(row.medication_id))
      fail('BACKUP_INVALID', '用药计划引用无效');
  }
  for (const table of ['health_records', 'medications'] as const)
    for (const row of backup.tables[table]!) {
      if (
        !users.has(String(row.owner_id)) ||
        !users.has(String(row.recorded_by)) ||
        !users.has(String(row.updated_by))
      )
        fail('BACKUP_INVALID', '记录成员引用无效');
      const data = JSON.parse(String(row.data)) as Row;
      if (table === 'medications')
        data.schedules = backup.tables
          .medication_schedules!.filter((schedule) => schedule.medication_id === row.id)
          .map((schedule) => JSON.parse(String(schedule.data)));
      const validated =
        table === 'health_records'
          ? healthInputSchema.parse(data)
          : medicationInputSchema.parse(data);
      if (validated.ownerId !== row.owner_id) fail('BACKUP_INVALID', '记录归属不一致');
    }
  const revisionKeys = new Set<string>();
  for (const row of backup.tables.record_revisions!) {
    const records = backup.tables[row.resource === 'health' ? 'health_records' : 'medications']!;
    const parent = records.find((record) => record.id === row.record_id);
    const content = JSON.parse(String(row.data)) as Row;
    if (
      !parent ||
      !users.has(String(row.actor_id)) ||
      content.id !== row.record_id ||
      content.ownerId !== parent.owner_id ||
      content.version !== row.version ||
      Number(row.version) > Number(parent.version)
    )
      fail('BACKUP_INVALID', '记录历史引用无效');
    const revisionKey = `${String(row.resource)}:${String(row.record_id)}:${String(row.version)}`;
    if (revisionKeys.has(revisionKey)) fail('BACKUP_INVALID', '历史版本重复');
    revisionKeys.add(revisionKey);
    const {
      id: recordId,
      version,
      recordedBy,
      updatedBy,
      createdAt,
      updatedAt,
      deletedAt,
      ...input
    } = content;
    z.object({
      id,
      version: z.number().int().positive(),
      recordedBy: id,
      updatedBy: id,
      createdAt: timestampSchema,
      updatedAt: timestampSchema,
      deletedAt: nullableTime,
    }).parse({ id: recordId, version, recordedBy, updatedBy, createdAt, updatedAt, deletedAt });
    if (
      recordedBy !== parent!.recorded_by ||
      updatedBy !== row.actor_id ||
      createdAt !== parent!.created_at ||
      updatedAt !== row.created_at
    )
      fail('BACKUP_INVALID', '历史录入人与时间不一致');
    (row.resource === 'health' ? healthInputSchema : medicationInputSchema).parse(input);
  }
  return backup;
}
interface Conflict {
  table: string;
  id: string;
  reason: string;
}
function mergePlan(current: BackupData, incoming: BackupData) {
  if (current.sourceId !== incoming.sourceId)
    fail('SOURCE_MISMATCH', '合并只支持同一家庭实例的备份；跨实例迁移请使用覆盖恢复');
  const imports: Record<string, Row[]> = {};
  const conflicts: Conflict[] = [];
  for (const table of tableNames) imports[table] = [];
  const currentUsers = new Set(current.tables.users!.map((row) => row.id));
  for (const table of insertOrder) {
    const existing = new Map(current.tables[table]!.map((row) => [key(table, row), row]));
    for (const row of incoming.tables[table]!) {
      const rowKey = key(table, row);
      const prior = existing.get(rowKey);
      if (prior) {
        if (canonical(prior) !== canonical(row) && table !== 'system_settings')
          conflicts.push({ table, id: rowKey, reason: '同一标识内容不同，保留当前数据' });
        continue;
      }
      if (
        ['system_settings', 'household', 'member_permissions'].includes(table) ||
        (table === 'users' &&
          (row.system_role !== null ||
            incoming.tables.household_members!.find((member) => member.user_id === row.id)?.role !==
              'member')) ||
        (table === 'household_members' && (row.role !== 'member' || currentUsers.has(row.user_id)))
      ) {
        conflicts.push({ table, id: rowKey, reason: '合并不新增管理权限、已有成员凭据或恢复码' });
        continue;
      }
      if (
        table === 'users' &&
        [...current.tables.users!, ...imports.users!].some((user) => user.phone === row.phone)
      ) {
        conflicts.push({ table, id: rowKey, reason: '手机号已存在，保留当前账号' });
        continue;
      }
      const availableUsers = new Set(
        [...current.tables.users!, ...imports.users!].map((user) => user.id),
      );
      const userReferences = [
        'user_id',
        'owner_id',
        'recorded_by',
        'updated_by',
        'actor_id',
      ].filter((field) => field in row);
      if (userReferences.some((field) => !availableUsers.has(row[field]))) {
        conflicts.push({ table, id: rowKey, reason: '引用的成员未导入' });
        continue;
      }
      if (
        table === 'medication_schedules' &&
        !imports.medications!.some((item) => item.id === row.medication_id)
      ) {
        conflicts.push({ table, id: rowKey, reason: '所属用药未新增，不修改当前计划' });
        continue;
      }
      if (
        table === 'record_revisions' &&
        !imports[row.resource === 'health' ? 'health_records' : 'medications']!.some(
          (item) => item.id === row.record_id,
        )
      ) {
        conflicts.push({ table, id: rowKey, reason: '所属记录未新增，保留当前历史' });
        continue;
      }
      imports[table]!.push(row);
    }
  }
  // A medication and all its schedules are one merge unit.
  const incomplete = new Set(
    imports
      .medications!.filter((medication) => {
        const expected = incoming.tables.medication_schedules!.filter(
          (row) => row.medication_id === medication.id,
        );
        return expected.some(
          (row) => !imports.medication_schedules!.some((imported) => imported.id === row.id),
        );
      })
      .map((row) => row.id),
  );
  for (const medicationId of incomplete)
    conflicts.push({
      table: 'medications',
      id: String(medicationId),
      reason: '用药计划标识冲突，整组保留为冲突，未导入不完整计划',
    });
  imports.medications = imports.medications!.filter((row) => !incomplete.has(row.id));
  imports.medication_schedules = imports.medication_schedules!.filter(
    (row) => !incomplete.has(row.medication_id),
  );
  imports.record_revisions = imports.record_revisions!.filter(
    (row) => row.resource !== 'medication' || !incomplete.has(row.record_id),
  );
  if (
    [...current.tables.household_members!, ...imports.household_members!].filter(
      (row) => row.active === 1,
    ).length > 10
  )
    fail('MEMBER_LIMIT', '合并后的有效家庭成员超过 10 人');
  return { imports, conflicts };
}
function insertRows(db: D1Database, table: Table, rows: Row[]) {
  const columns = Object.keys(schemas[table].shape);
  return db
    .prepare(
      `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map((column) => `json_extract(value,'$.${column}')`).join(',')} FROM json_each(?)`,
    )
    .bind(JSON.stringify(rows));
}
export const backups = new Hono<AppEnv>();
backups.use('*', async (context, next) => {
  admin(context, true);
  await requireFresh(context);
  await next();
});
backups.get('/export', async (context) => ok(context, await exportData(context.env.DB)));
backups.post('/preview', async (context) => {
  const { backup: raw, mode } = z
    .object({ backup: z.unknown(), mode: z.enum(['merge', 'overwrite']) })
    .parse(await context.req.json());
  const incoming = validateBackup(raw);
  const current = await exportData(context.env.DB);
  boundedJson(current);
  const plan =
    mode === 'merge'
      ? mergePlan(current, incoming)
      : { imports: incoming.tables, conflicts: [] as Conflict[] };
  const previewId = crypto.randomUUID();
  const expiresAt = later(10);
  const revision = Number(current.tables.system_settings![0]!.revision);
  const summary = {
    mode,
    sourceId: incoming.sourceId,
    createdAt: incoming.createdAt,
    users: incoming.tables.users!.length,
    healthRecords: incoming.tables.health_records!.length,
    medications: incoming.tables.medications!.length,
    importRows: tableNames.reduce((sum, table) => sum + (plan.imports[table]?.length ?? 0), 0),
    conflictCount: plan.conflicts.length,
  };
  await context.env.DB.prepare(
    'INSERT INTO restore_previews(id,user_id,mode,data,revision,expires_at) VALUES (?,?,?,?,?,?)',
  )
    .bind(
      previewId,
      context.get('actor').id,
      mode,
      boundedJson({ backup: incoming, imports: plan.imports }, 1500 * 1024),
      revision,
      expiresAt,
    )
    .run();
  return ok(context, { previewId, summary, conflicts: plan.conflicts, expiresAt });
});
backups.post('/restore', async (context) => {
  const { previewId } = z.object({ previewId: z.string().uuid() }).parse(await context.req.json());
  const db = context.env.DB;
  const preview = await db
    .prepare(
      'SELECT * FROM restore_previews WHERE id=? AND user_id=? AND used_at IS NULL AND expires_at>?',
    )
    .bind(previewId, context.get('actor').id, beijingNow())
    .first<{ mode: 'merge' | 'overwrite'; data: string; revision: number }>();
  if (!preview) fail('PREVIEW_EXPIRED', '恢复预览已失效', 409);
  const current = await exportData(db);
  const currentSnapshot = boundedJson(current);
  const { backup, imports } = JSON.parse(preview!.data) as {
    backup: BackupData;
    imports: Record<string, Row[]>;
  };
  const epoch = crypto.randomUUID();
  const now = beijingNow();
  const statements = [
    activeCheck(db, context.get('actor').id),
    db
      .prepare(
        'UPDATE restore_previews SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>? AND revision=(SELECT revision FROM system_settings WHERE id=1)',
      )
      .bind(now, previewId, now),
    check(db, 'changes()=1'),
    db
      .prepare('INSERT INTO restore_snapshots(id,data,created_at) VALUES (?,?,?)')
      .bind(crypto.randomUUID(), currentSnapshot, now),
  ];
  for (const table of [
    'login_requests',
    'sessions',
    'challenges',
    'qr_logins',
    'invitations',
    'recovery_tickets',
    'sync_operations',
    'restore_previews',
  ])
    statements.push(db.prepare(`DELETE FROM ${table}`));
  if (preview!.mode === 'overwrite') {
    statements.push(
      db.prepare('DELETE FROM credentials'),
      db.prepare('DELETE FROM recovery_codes'),
    );
    for (const table of [...insertOrder].reverse())
      statements.push(db.prepare(`DELETE FROM ${table}`));
    for (const table of insertOrder) statements.push(insertRows(db, table, backup.tables[table]!));
  } else
    for (const table of insertOrder)
      if (imports[table]?.length) statements.push(insertRows(db, table, imports[table]!));
  statements.push(
    db
      .prepare('UPDATE system_settings SET epoch=?,revision=? WHERE id=1')
      .bind(epoch, preview!.revision + 1),
  );
  try {
    await atomic(db, statements);
  } catch {
    return fail(
      'RESTORE_CONFLICT',
      '数据已变化或恢复校验失败，未写入任何业务数据，请重新预览',
      409,
    );
  }
  return ok(context, { ok: true, epoch });
});
