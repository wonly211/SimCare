import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { beijingNow, phoneSchema } from '@simcare/shared';
import {
  activeCheck,
  admin,
  atomic,
  check,
  fail,
  getMember,
  hash,
  later,
  ok,
  revisionBump,
  sessionData,
  token,
  type AppEnv,
  type AppContext,
} from './core';

const cookieName = 'simcare_session';
const lifetime = 180 * 24 * 60;
const deviceName = z.string().trim().min(1).max(80).default('我的设备');
export function initKey(context: AppContext) {
  const { init_key: current, INIT_KEY: legacy } = context.env;
  if (current && legacy && current !== legacy)
    fail('CONFIG_CONFLICT', 'init_key 与 INIT_KEY 不一致，请在 Worker 设置中统一配置', 503);
  return current || legacy;
}
function sessionCookie(context: AppContext, value: string) {
  setCookie(context, cookieName, value, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: lifetime * 60,
  });
}
export async function authenticate(context: AppContext, optional = false) {
  const raw = getCookie(context, cookieName);
  const session = raw
    ? await context.env.DB.prepare(
        'SELECT user_id,verified_at,renewed_at,created_at FROM sessions WHERE token_hash=? AND expires_at>?',
      )
        .bind(await hash(raw), beijingNow())
        .first<{
          user_id: string;
          verified_at: string;
          renewed_at: string | null;
          created_at: string;
        }>()
    : null;
  const actor = session && (await getMember(context.env.DB, session.user_id));
  if (!actor?.active) {
    if (optional) return null;
    return fail('UNAUTHENTICATED', '请申请设备登录，或由系统管理员恢复登录', 401);
  }
  context.set('actor', actor);
  context.set('sessionHash', await hash(raw!));
  context.set('verifiedAt', session!.verified_at);
  if (Date.parse(session!.renewed_at ?? session!.created_at) < Date.now() - 86400000) {
    const renewed = await context.env.DB.prepare(
      'UPDATE sessions SET renewed_at=?,expires_at=? WHERE token_hash=? AND expires_at>? AND COALESCE(renewed_at,created_at)<?',
    )
      .bind(
        beijingNow(),
        later(lifetime),
        await hash(raw!),
        beijingNow(),
        beijingNow(new Date(Date.now() - 86400000)),
      )
      .run();
    if (renewed.meta.changes) sessionCookie(context, raw!);
  }
  return actor;
}
function sessionStatement(db: D1Database, valueHash: string, userId: string, name: string) {
  const now = beijingNow();
  return db
    .prepare(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at,verified_at,device_id,device_name,renewed_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .bind(valueHash, userId, now, later(lifetime), now, crypto.randomUUID(), name, now);
}
async function verifyKey(context: AppContext, provided: string) {
  const expected = initKey(context);
  if (!expected) fail('SETUP_REQUIRED', '请在 Worker 设置中添加普通变量 init_key', 503);
  if ((await hash(provided)) !== (await hash(expected!)))
    fail('INIT_KEY_INVALID', '初始化密钥无效', 403);
}
type RequestRow = {
  id: string;
  phone: string;
  nickname: string;
  device_name: string;
  poll_hash: string;
  invitation_hash: string | null;
  user_id: string | null;
  approved_by: string | null;
  status: string;
  expires_at: string;
  created_at: string;
};
const approvalPredicate = `EXISTS(SELECT 1 FROM users a JOIN household_members am ON am.user_id=a.id JOIN users t ON t.id=? JOIN household_members tm ON tm.user_id=t.id WHERE a.id=? AND a.active=1 AND am.active=1 AND t.active=1 AND tm.active=1 AND a.id<>t.id AND t.system_role IS NULL AND (a.system_role='system_admin' OR (am.role='admin' AND tm.role='member')))`;
function approverCheck(db: D1Database, target: string, approver: string) {
  return check(db, approvalPredicate, [target, approver]);
}
async function canApprove(context: AppContext, row: RequestRow) {
  const actor = admin(context);
  if (row.user_id) {
    const target = await getMember(context.env.DB, row.user_id);
    if (
      !target?.active ||
      target.id === actor.id ||
      target.systemRole ||
      (actor.systemRole !== 'system_admin' && target.householdRole !== 'member')
    )
      fail('FORBIDDEN', '无权批准此账号的设备', 403);
  }
  return actor;
}
export const auth = new Hono<AppEnv>();
auth.use('*', async (context, next) => {
  if (
    context.req.method === 'POST' &&
    ['/initialize', '/admin-recover', '/requests'].includes(
      context.req.path.replace('/api/v1/auth', ''),
    )
  ) {
    const bucket = Math.floor(Date.now() / 60000);
    const key = await hash(
      `${context.req.header('CF-Connecting-IP') ?? 'local'}:${context.req.path}`,
    );
    const row = await context.env.DB.prepare(
      'INSERT INTO auth_rate_limits(key_hash,bucket,count) VALUES(?,?,1) ON CONFLICT(key_hash,bucket) DO UPDATE SET count=count+1 RETURNING count',
    )
      .bind(key, bucket)
      .first<{ count: number }>();
    if (row && row.count > 30) fail('RATE_LIMITED', '操作频繁，请稍后再试', 429);
    await context.env.DB.prepare('DELETE FROM auth_rate_limits WHERE bucket<?')
      .bind(bucket - 10)
      .run();
  }
  await next();
});
auth.get('/status', async (context) => {
  const key = initKey(context);
  const row = await context.env.DB.prepare(
    'SELECT initialized FROM system_settings WHERE id=1',
  ).first<{ initialized: number }>();
  return ok(context, { initialized: !!row?.initialized, configured: !!key });
});
auth.get('/session', async (context) => {
  const actor = await authenticate(context);
  return ok(context, await sessionData(context.env.DB, actor!));
});
auth.post('/initialize', async (context) => {
  const input = z
    .object({
      phone: phoneSchema,
      nickname: z.string().trim().min(1).max(80),
      initKey: z.string().min(1).max(1000),
      deviceName,
    })
    .strict()
    .parse(await context.req.json());
  await verifyKey(context, input.initKey);
  const db = context.env.DB,
    userId = crypto.randomUUID(),
    household = crypto.randomUUID(),
    value = token(),
    now = beijingNow();
  try {
    await atomic(db, [
      check(db, '(SELECT initialized FROM system_settings WHERE id=1)=0'),
      db
        .prepare('INSERT INTO household(id,name,created_at) VALUES(?,?,?)')
        .bind(household, '我的家庭', now),
      db
        .prepare(
          "INSERT INTO users(id,nickname,system_role,active,created_at,phone) VALUES(?,?,'system_admin',1,?,?)",
        )
        .bind(userId, input.nickname, now, input.phone),
      db
        .prepare(
          "INSERT INTO household_members(user_id,household_id,role,active) VALUES(?,?,'admin',1)",
        )
        .bind(userId, household),
      db
        .prepare(
          'UPDATE system_settings SET initialized=1,household_id=?,epoch=?,revision=revision+1 WHERE id=1',
        )
        .bind(household, crypto.randomUUID()),
      sessionStatement(db, await hash(value), userId, input.deviceName),
    ]);
  } catch {
    return fail('INITIALIZATION_CONFLICT', '家庭已初始化或手机号已存在', 409);
  }
  sessionCookie(context, value);
  return ok(context, await sessionData(db, (await getMember(db, userId))!));
});
auth.post('/admin-recover', async (context) => {
  const input = z
    .object({ phone: phoneSchema, initKey: z.string().min(1).max(1000), deviceName })
    .strict()
    .parse(await context.req.json());
  await verifyKey(context, input.initKey);
  const db = context.env.DB;
  const user = await db
    .prepare("SELECT id FROM users WHERE phone=? AND system_role='system_admin' AND active=1")
    .bind(input.phone)
    .first<{ id: string }>();
  if (!user) fail('RECOVERY_INVALID', '手机号与系统管理员不匹配', 403);
  const value = token();
  await atomic(db, [
    activeCheck(db, user!.id),
    sessionStatement(db, await hash(value), user!.id, input.deviceName),
  ]);
  sessionCookie(context, value);
  return ok(context, await sessionData(db, (await getMember(db, user!.id))!));
});
auth.post('/requests', async (context) => {
  const input = z
    .object({
      phone: phoneSchema,
      nickname: z.string().trim().min(1).max(80).optional(),
      inviteToken: z.string().max(200).optional(),
      deviceName,
    })
    .strict()
    .parse(await context.req.json());
  const db = context.env.DB;
  const existing = await db
    .prepare('SELECT id FROM users WHERE phone=?')
    .bind(input.phone)
    .first<{ id: string }>();
  if (existing && !(await getMember(db, existing.id))?.active)
    fail('ACCOUNT_DISABLED', '账户已停用', 403);
  let invitationHash: string | null = null;
  if (!existing) {
    if (!input.inviteToken || !input.nickname)
      fail('INVITATION_REQUIRED', '新成员请使用管理员的邀请链接并填写昵称', 400);
    invitationHash = await hash(input.inviteToken!);
    const invite = await db
      .prepare(
        "SELECT id FROM invitations WHERE token_hash=? AND role='member' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .bind(invitationHash, beijingNow())
      .first();
    if (!invite) fail('INVITATION_INVALID', '邀请已失效', 400);
  }
  if (existing && (await getMember(db, existing.id))?.systemRole)
    fail('ADMIN_RECOVERY_REQUIRED', '系统管理员请使用手机号和 init_key 登录', 400);
  const id = crypto.randomUUID(),
    pollToken = token(),
    expiresAt = later(10);
  await db
    .prepare(
      "INSERT INTO login_requests(id,phone,nickname,device_name,poll_hash,invitation_hash,user_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)",
    )
    .bind(
      id,
      input.phone,
      input.nickname ?? '',
      input.deviceName,
      await hash(pollToken),
      invitationHash,
      existing?.id ?? null,
      beijingNow(),
      expiresAt,
    )
    .run();
  return ok(context, { id, pollToken, expiresAt });
});
auth.get('/requests', async (context) => {
  await authenticate(context);
  const actor = admin(context);
  const result = await context.env.DB.prepare(
    `SELECT r.*, u.nickname AS member_nickname FROM login_requests r
     LEFT JOIN users u ON u.id=r.user_id LEFT JOIN household_members m ON m.user_id=r.user_id
     WHERE r.status='pending' AND r.expires_at>? AND (r.user_id IS NULL OR (u.active=1 AND m.active=1 AND u.system_role IS NULL AND u.id<>? AND (?=1 OR m.role='member')))
     ORDER BY r.created_at DESC LIMIT 100`,
  )
    .bind(beijingNow(), actor.id, Number(actor.systemRole === 'system_admin'))
    .all<RequestRow & { member_nickname: string | null }>();
  const items = result.results.map((row) => ({
    id: row.id,
    phone: row.phone,
    nickname: row.member_nickname ?? row.nickname,
    deviceName: row.device_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    newMember: !row.user_id,
  }));
  return ok(context, items);
});
auth.post('/requests/:id/decision', async (context) => {
  await authenticate(context);
  const { approve } = z
    .object({ approve: z.boolean() })
    .strict()
    .parse(await context.req.json());
  const db = context.env.DB;
  const row = await db
    .prepare("SELECT * FROM login_requests WHERE id=? AND status='pending' AND expires_at>?")
    .bind(context.req.param('id'), beijingNow())
    .first<RequestRow>();
  if (!row) fail('REQUEST_EXPIRED', '申请已处理或过期', 409);
  const actor = await canApprove(context, row!);
  const now = beijingNow(),
    userId = row!.user_id ?? crypto.randomUUID();
  const statements = [activeCheck(db, actor.id)];
  if (!row!.user_id) {
    statements.push(
      check(
        db,
        "EXISTS(SELECT 1 FROM household_members WHERE user_id=? AND role='admin' AND active=1)",
        [actor.id],
      ),
    );
    if (approve) {
      statements.push(
        db
          .prepare(
            "UPDATE invitations SET used_at=? WHERE token_hash=? AND role='member' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM users u JOIN household_members m ON m.user_id=u.id WHERE u.id=invitations.created_by AND u.active=1 AND m.active=1 AND m.role='admin')",
          )
          .bind(now, row!.invitation_hash, now),
        check(db, 'changes()=1'),
        check(db, '(SELECT COUNT(*) FROM household_members WHERE active=1)<10'),
        db
          .prepare(
            'INSERT INTO users(id,nickname,system_role,active,created_at,phone) VALUES(?,?,NULL,1,?,?)',
          )
          .bind(userId, row!.nickname, now, row!.phone),
        db
          .prepare(
            "INSERT INTO household_members(user_id,household_id,role,active) SELECT ?,household_id,'member',1 FROM system_settings WHERE id=1",
          )
          .bind(userId),
      );
    }
  } else statements.push(approverCheck(db, userId, actor.id));
  statements.push(
    db
      .prepare(
        "UPDATE login_requests SET status=?,approved_by=?,user_id=? WHERE id=? AND status='pending' AND expires_at>?",
      )
      .bind(
        approve ? 'approved' : 'rejected',
        actor.id,
        approve ? userId : row!.user_id,
        row!.id,
        now,
      ),
    check(db, 'changes()=1'),
    revisionBump(db),
  );
  try {
    await atomic(db, statements);
  } catch {
    return fail('APPROVAL_CONFLICT', '申请、邀请、手机号或成员权限已变化，请刷新', 409);
  }
  return ok(context, { ok: true });
});
auth.post('/requests/:id/poll', async (context) => {
  const { pollToken } = z
    .object({ pollToken: z.string().min(32).max(200) })
    .strict()
    .parse(await context.req.json());
  const db = context.env.DB;
  const row = await db
    .prepare('SELECT * FROM login_requests WHERE id=? AND poll_hash=?')
    .bind(context.req.param('id'), await hash(pollToken))
    .first<RequestRow>();
  if (!row) fail('REQUEST_INVALID', '登录申请无效', 404);
  if (Date.parse(row!.expires_at) <= Date.now()) return ok(context, { status: 'expired' });
  if (row!.status !== 'approved') return ok(context, { status: row!.status });
  const value = token();
  try {
    await atomic(db, [
      approverCheck(db, row!.user_id!, row!.approved_by!),
      db
        .prepare(
          "UPDATE login_requests SET status='claimed' WHERE id=? AND status='approved' AND expires_at>?",
        )
        .bind(row!.id, beijingNow()),
      check(db, 'changes()=1'),
      sessionStatement(db, await hash(value), row!.user_id!, row!.device_name),
    ]);
  } catch {
    return fail('APPROVAL_CONFLICT', '批准已失效，请重新申请', 409);
  }
  sessionCookie(context, value);
  return ok(context, {
    status: 'approved',
    session: await sessionData(db, (await getMember(db, row!.user_id!))!),
  });
});
auth.get('/devices', async (context) => {
  const actor = await authenticate(context);
  const result = await context.env.DB.prepare(
    'SELECT device_id,device_name,created_at,renewed_at,expires_at,token_hash FROM sessions WHERE user_id=? AND expires_at>?',
  )
    .bind(actor!.id, beijingNow())
    .all<{
      device_id: string;
      device_name: string;
      created_at: string;
      renewed_at: string;
      expires_at: string;
      token_hash: string;
    }>();
  return ok(
    context,
    result.results
      .filter((row) => row.device_id)
      .map((row) => ({
        id: row.device_id,
        name: row.device_name,
        createdAt: row.created_at,
        lastUsedAt: row.renewed_at,
        expiresAt: row.expires_at,
        current: row.token_hash === context.get('sessionHash'),
      })),
  );
});
auth.delete('/devices/:id', async (context) => {
  const actor = await authenticate(context);
  const result = await context.env.DB.prepare(
    'DELETE FROM sessions WHERE device_id=? AND user_id=? RETURNING token_hash',
  )
    .bind(context.req.param('id'), actor!.id)
    .first<{ token_hash: string }>();
  if (result?.token_hash === context.get('sessionHash'))
    deleteCookie(context, cookieName, { path: '/' });
  return ok(context, { ok: true });
});
auth.post('/logout', async (context) => {
  const raw = getCookie(context, cookieName);
  if (raw)
    await context.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?')
      .bind(await hash(raw))
      .run();
  deleteCookie(context, cookieName, { path: '/' });
  return ok(context, { ok: true });
});
