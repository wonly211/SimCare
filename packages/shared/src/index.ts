import { z } from 'zod';

export type SystemRole = 'system_admin' | null;
export type HouseholdRole = 'admin' | 'member';
export type MemberGrant = 'none' | 'view' | 'care';
export type SyncStatus = 'pending' | 'synced' | 'conflict' | 'failed';
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
export type ApiResponse<T> =
  | { success: true; data: T; error: null; request_id: string }
  | { success: false; data: null; error: ApiError; request_id: string };
export interface Member {
  id: string;
  nickname: string;
  phone?: string | null;
  systemRole: SystemRole;
  householdRole: HouseholdRole;
  active: boolean;
  createdAt: string;
}
export interface Grant {
  ownerId: string;
  granteeId: string;
  grant: MemberGrant;
}
export interface Session {
  user: Member;
  household: { id: string; name: string };
  epoch: string;
}

export function beijingNow(date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+08:00';
}
export function beijingDate(date = new Date()): string {
  return beijingNow(date).slice(0, 10);
}
export const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && beijingNow(new Date(value)) === value,
    '时间无效',
  );
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
  }, '日期无效');
const optionalNumber = z.number().finite().nonnegative().nullable();
export const healthInputSchema = z
  .object({
    ownerId: z.string().uuid(),
    measuredAt: timestampSchema,
    systolic: optionalNumber,
    diastolic: optionalNumber,
    pulse: optionalNumber,
    oxygen: z.number().min(0).max(100).nullable(),
    temperature: z.number().finite().nullable(),
    posture: z.enum(['sitting', 'standing', 'lying', 'unspecified']),
    arm: z.enum(['left', 'right', 'unspecified']),
    note: z.string().max(2000),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      [record.systolic, record.diastolic, record.pulse, record.oxygen, record.temperature].every(
        (value) => value === null,
      )
    )
      context.addIssue({ code: 'custom', message: '至少填写一项测量数据' });
    if ((record.systolic === null) !== (record.diastolic === null))
      context.addIssue({ code: 'custom', message: '请同时填写收缩压和舒张压' });
  });
export type HealthInput = z.infer<typeof healthInputSchema>;
export interface RecordMeta {
  id: string;
  version: number;
  recordedBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export type HealthRecord = HealthInput & RecordMeta;
export const scheduleSchema = z
  .object({
    id: z.string().uuid(),
    period: z.enum(['morning', 'noon', 'evening', 'time', 'as_needed']),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    dose: z.string().trim().min(1).max(40),
    unit: z.string().trim().min(1).max(20),
    meal: z.enum(['before', 'with', 'after', 'any']),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  })
  .strict()
  .refine((item) => item.period !== 'time' || item.time !== null, '具体时间不能为空');
export type MedicationSchedule = z.infer<typeof scheduleSchema>;
export const medicationInputSchema = z
  .object({
    ownerId: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    specification: z.string().max(100),
    form: z.string().max(40),
    route: z.string().max(40),
    reason: z.string().max(200),
    note: z.string().max(2000),
    startDate: dateSchema,
    endDate: dateSchema.nullable(),
    status: z.enum(['active', 'paused', 'completed']),
    schedules: z.array(scheduleSchema).min(1).max(12),
  })
  .strict()
  .refine((item) => !item.endDate || item.endDate >= item.startDate, '结束日期早于开始日期');
export type MedicationInput = z.infer<typeof medicationInputSchema>;
export type Medication = MedicationInput & RecordMeta;
export interface TodayDose {
  medication: Medication;
  schedule: MedicationSchedule;
  sortTime: string;
}
export function todayMedication(medications: Medication[], date = beijingDate()): TodayDose[] {
  dateSchema.parse(date);
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  const order = {
    morning: '08:00',
    noon: '12:00',
    evening: '18:00',
    time: '00:00',
    as_needed: '99:99',
  };
  return medications
    .filter(
      (item) =>
        !item.deletedAt &&
        item.status === 'active' &&
        item.startDate <= date &&
        (!item.endDate || item.endDate >= date),
    )
    .flatMap((medication) =>
      medication.schedules
        .filter((schedule) => schedule.weekdays.includes(weekday))
        .map((schedule) => ({
          medication,
          schedule,
          sortTime:
            schedule.period === 'as_needed'
              ? order.as_needed
              : (schedule.time ?? order[schedule.period]),
        })),
    )
    .sort(
      (left, right) =>
        left.sortTime.localeCompare(right.sortTime) ||
        left.medication.name.localeCompare(right.medication.name, 'zh-CN'),
    );
}
export function canViewHealth(actor: Member, ownerId: string, grants: Grant[]): boolean {
  return (
    actor.active &&
    (actor.id === ownerId ||
      actor.householdRole === 'admin' ||
      grants.some(
        (item) => item.ownerId === ownerId && item.granteeId === actor.id && item.grant !== 'none',
      ))
  );
}
export function canCreateHealth(actor: Member, ownerId: string, grants: Grant[]): boolean {
  return (
    actor.active &&
    (actor.id === ownerId ||
      actor.householdRole === 'admin' ||
      grants.some(
        (item) => item.ownerId === ownerId && item.granteeId === actor.id && item.grant === 'care',
      ))
  );
}
export function canEditOwned(actor: Member, ownerId: string): boolean {
  return (
    actor.active &&
    (actor.id === ownerId || actor.householdRole === 'admin' || actor.systemRole === 'system_admin')
  );
}

export interface SyncOperation {
  operationId: string;
  epoch: string;
  resource: 'health' | 'medication';
  recordId: string;
  baseVersion: number;
  action: 'upsert' | 'delete' | 'restore';
  data?: HealthInput | MedicationInput;
}
export interface SyncResult {
  operationId: string;
  status: 'applied' | 'conflict' | 'rejected';
  record?: HealthRecord | Medication;
  error?: ApiError;
}
export interface SyncSnapshot {
  epoch: string;
  revision: string;
  members: Member[];
  grants: Grant[];
  healthRecords: HealthRecord[];
  medications: Medication[];
}
export interface Revision<T> {
  id: string;
  recordId: string;
  version: number;
  data: T;
  actorId: string;
  createdAt: string;
}
export interface Invitation {
  id: string;
  role: HouseholdRole;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface Credential {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface BackupData {
  format: 'simcare';
  version: 2;
  createdAt: string;
  sourceId: string;
  tables: Record<string, Record<string, unknown>[]>;
}
export interface BackupEnvelope {
  format: 'simcare-encrypted';
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  cipher: 'AES-256-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
}
export const labels = {
  posture: { sitting: '坐姿', standing: '站姿', lying: '卧姿', unspecified: '未指定' },
  arm: { left: '左臂', right: '右臂', unspecified: '未指定' },
  period: { morning: '早', noon: '中', evening: '晚', time: '指定时间', as_needed: '按需' },
  meal: { before: '饭前', with: '随餐', after: '饭后', any: '不限' },
  status: { active: '使用中', paused: '暂停', completed: '已完成' },
} as const;
export * from './backup';

export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^\+86\s*/, '').replace(/[ -]/g, ''))
  .pipe(z.string().regex(/^1[3-9]\d{9}$/, '请输入中国大陆手机号'));
export interface LoginRequest {
  id: string;
  phone: string;
  nickname: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
  newMember: boolean;
}
export interface LoginTicket {
  id: string;
  pollToken: string;
  expiresAt: string;
}
export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}
