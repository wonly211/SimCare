import { beijingNow, type ApiError, type Member, type Session } from '@simcare/shared';
import type { Context } from 'hono';

export interface Bindings {
  DB: D1Database;
  APP_ORIGIN?: string;
  RP_ID?: string;
  init_key?: string;
  INIT_KEY?: string;
  ENVIRONMENT?: string;
  ASSETS?: Fetcher;
}
export interface Variables {
  requestId: string;
  actor: Member;
  sessionHash: string;
  verifiedAt: string;
}
export type AppEnv = { Bindings: Bindings; Variables: Variables };
export type AppContext = Context<AppEnv>;
export class Fault extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const fail = (code: string, message: string, status = 400): never => {
  throw new Fault(code, message, status);
};
export function ok<T>(context: AppContext, data: T) {
  return context.json({ success: true, data, error: null, request_id: context.get('requestId') });
}
export function apiError(error: unknown): ApiError {
  return error instanceof Fault
    ? { code: error.code, message: error.message, details: error.details }
    : { code: 'INTERNAL', message: '操作失败，请稍后重试' };
}
export const later = (minutes: number) => beijingNow(new Date(Date.now() + minutes * 60_000));
export function token() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (item) => item.toString(16).padStart(2, '0'),
  ).join('');
}
export function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
export function decode(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export const memberSql = `SELECT u.id, u.phone, u.nickname, u.system_role, u.active AS user_active, u.created_at, m.role, m.active FROM users u JOIN household_members m ON m.user_id = u.id`;
export interface MemberRow {
  phone: string | null;
  id: string;
  nickname: string;
  system_role: 'system_admin' | null;
  user_active: number;
  created_at: string;
  role: 'admin' | 'member';
  active: number;
}
export function memberFrom(row: MemberRow): Member {
  return {
    id: row.id,
    nickname: row.nickname,
    phone: row.phone,
    systemRole: row.system_role,
    householdRole: row.role,
    active: !!row.active && !!row.user_active,
    createdAt: row.created_at,
  };
}
export async function getMember(db: D1Database, id: string): Promise<Member | null> {
  const row = await db.prepare(`${memberSql} WHERE u.id = ?`).bind(id).first<MemberRow>();
  return row ? memberFrom(row) : null;
}
export async function sessionData(db: D1Database, user: Member): Promise<Session> {
  const row = await db
    .prepare(
      'SELECT s.epoch,h.id,h.name FROM system_settings s JOIN household h ON h.id=s.household_id WHERE s.id=1',
    )
    .first<{ epoch: string; id: string; name: string }>();
  if (!row) fail('NOT_INITIALIZED', '系统尚未初始化', 409);
  return { user, household: { id: row!.id, name: row!.name }, epoch: row!.epoch };
}
export function admin(context: AppContext, systemOnly = false) {
  const actor = context.get('actor');
  if (
    systemOnly
      ? actor.systemRole !== 'system_admin'
      : actor.householdRole !== 'admin' && actor.systemRole !== 'system_admin'
  )
    fail('FORBIDDEN', '无权执行此操作', 403);
  return actor;
}
export async function requireMember(context: AppContext, id: string) {
  const member = await getMember(context.env.DB, id);
  if (!member) fail('NOT_FOUND', '成员不存在', 404);
  return member!;
}
export function activeCheck(db: D1Database, userId: string) {
  return check(
    db,
    `EXISTS(SELECT 1 FROM users u JOIN household_members m ON m.user_id=u.id WHERE u.id=? AND u.active=1 AND m.active=1)`,
    [userId],
  );
}
export function adminCheck(db: D1Database, userId: string, systemOnly = false) {
  return check(
    db,
    `EXISTS(SELECT 1 FROM users u JOIN household_members m ON m.user_id=u.id WHERE u.id=? AND u.active=1 AND m.active=1 AND ${systemOnly ? "u.system_role='system_admin'" : "(u.system_role='system_admin' OR m.role='admin')"})`,
    [userId],
  );
}
export function check(db: D1Database, predicate: string, args: (string | number | null)[] = []) {
  return db
    .prepare(
      `INSERT INTO atomic_checks(id,valid) VALUES (?, CASE WHEN (${predicate}) THEN 1 ELSE 0 END)`,
    )
    .bind(crypto.randomUUID(), ...args);
}
export async function atomic(db: D1Database, statements: D1PreparedStatement[]) {
  return db.batch([...statements, db.prepare('DELETE FROM atomic_checks')]);
}
export function revisionBump(db: D1Database) {
  return db.prepare('UPDATE system_settings SET revision=revision+1 WHERE id=1');
}
export async function requireFresh(context: AppContext) {
  // An approved active device authorizes sensitive operations; no Passkey re-authentication.
  await atomic(context.env.DB, [activeCheck(context.env.DB, context.get('actor').id)]);
}
