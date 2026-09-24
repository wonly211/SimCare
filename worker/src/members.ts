import { Hono } from 'hono';
import { z } from 'zod';
import { beijingNow, type Grant } from '@simcare/shared';
import {
  activeCheck,
  admin,
  adminCheck,
  atomic,
  check,
  fail,
  hash,
  later,
  memberFrom,
  memberSql,
  ok,
  requireFresh,
  requireMember,
  revisionBump,
  token,
  type AppEnv,
  type MemberRow,
} from './core';

export const members = new Hono<AppEnv>();
members.get('/', async (context) => {
  const result = await context.env.DB.prepare(memberSql).all<MemberRow>();
  return ok(context, result.results.map(memberFrom));
});
members.patch('/:id', async (context) => {
  const input = z
    .object({
      nickname: z.string().trim().min(1).max(80).optional(),
      active: z.boolean().optional(),
      householdRole: z.enum(['admin', 'member']).optional(),
    })
    .strict()
    .parse(await context.req.json());
  const actor = context.get('actor');
  const target = await requireMember(context, context.req.param('id'));
  const db = context.env.DB;
  if (actor.id !== target.id) admin(context);
  if (input.active !== undefined || input.householdRole !== undefined) {
    admin(context);
    await requireFresh(context);
    if (target.systemRole === 'system_admin')
      fail('PROTECTED_ACCOUNT', '系统管理员不能被停用或撤销家庭管理员身份', 403);
    if (input.householdRole !== undefined && actor.systemRole !== 'system_admin')
      fail('FORBIDDEN', '只有系统管理员可以变更家庭角色', 403);
    if (
      input.active !== undefined &&
      actor.systemRole !== 'system_admin' &&
      target.householdRole === 'admin'
    )
      fail('FORBIDDEN', '家庭管理员不能停用其他管理员', 403);
  }
  const statements = [activeCheck(db, actor.id)];
  if (actor.id !== target.id || input.active !== undefined || input.householdRole !== undefined)
    statements.push(adminCheck(db, actor.id, input.householdRole !== undefined));
  if (input.nickname !== undefined)
    statements.push(
      db.prepare('UPDATE users SET nickname=? WHERE id=?').bind(input.nickname, target.id),
    );
  if (input.active !== undefined) {
    if (input.active && !target.active)
      statements.push(check(db, '(SELECT COUNT(*) FROM household_members WHERE active=1)<10'));
    statements.push(
      db.prepare('UPDATE users SET active=? WHERE id=?').bind(Number(input.active), target.id),
      db
        .prepare('UPDATE household_members SET active=? WHERE user_id=?')
        .bind(Number(input.active), target.id),
    );
    if (!input.active)
      statements.push(
        db.prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id),
        db
          .prepare('UPDATE invitations SET revoked_at=? WHERE created_by=?')
          .bind(beijingNow(), target.id),
        db
          .prepare('DELETE FROM recovery_tickets WHERE user_id=? OR issuer_id=?')
          .bind(target.id, target.id),
        db.prepare('DELETE FROM qr_logins WHERE approved_user_id=?').bind(target.id),
        db
          .prepare('DELETE FROM login_requests WHERE user_id=? OR approved_by=?')
          .bind(target.id, target.id),
      );
  }
  if (input.householdRole !== undefined)
    statements.push(
      db
        .prepare('UPDATE household_members SET role=? WHERE user_id=?')
        .bind(input.householdRole, target.id),
    );
  statements.push(revisionBump(db));
  await atomic(db, statements);
  return ok(context, await requireMember(context, target.id));
});

export async function grants(db: D1Database): Promise<Grant[]> {
  const result = await db
    .prepare('SELECT owner_id,grantee_id,permission FROM member_permissions')
    .all<{ owner_id: string; grantee_id: string; permission: Grant['grant'] }>();
  return result.results.map((row) => ({
    ownerId: row.owner_id,
    granteeId: row.grantee_id,
    grant: row.permission,
  }));
}
export const permissions = new Hono<AppEnv>();
permissions.get('/', async (context) => {
  const actor = context.get('actor');
  return ok(
    context,
    (await grants(context.env.DB)).filter(
      (item) =>
        actor.householdRole === 'admin' || item.ownerId === actor.id || item.granteeId === actor.id,
    ),
  );
});
permissions.put('/:granteeId', async (context) => {
  const input = z
    .object({ grant: z.enum(['none', 'view', 'care']) })
    .strict()
    .parse(await context.req.json());
  const actor = context.get('actor');
  const grantee = await requireMember(context, context.req.param('granteeId'));
  const db = context.env.DB;
  if (actor.id === grantee.id || grantee.householdRole === 'admin')
    fail('FIXED_PERMISSION', '本人和家庭管理员权限不可更改', 400);
  await atomic(db, [
    activeCheck(db, actor.id),
    check(db, "EXISTS(SELECT 1 FROM household_members WHERE user_id=? AND role='member')", [
      grantee.id,
    ]),
    db
      .prepare(
        'INSERT INTO member_permissions(owner_id,grantee_id,permission) VALUES (?,?,?) ON CONFLICT(owner_id,grantee_id) DO UPDATE SET permission=excluded.permission',
      )
      .bind(actor.id, grantee.id, input.grant),
    revisionBump(db),
  ]);
  return ok(context, {
    ownerId: actor.id,
    granteeId: grantee.id,
    grant: input.grant,
  } satisfies Grant);
});

export const invitations = new Hono<AppEnv>();
invitations.get('/', async (context) => {
  admin(context);
  const result = await context.env.DB.prepare(
    'SELECT id,role,expires_at,used_at,revoked_at FROM invitations ORDER BY expires_at DESC',
  ).all<{
    id: string;
    role: string;
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
  }>();
  return ok(
    context,
    result.results.map((row) => ({
      id: row.id,
      role: row.role,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
    })),
  );
});
invitations.post('/', async (context) => {
  const actor = admin(context);
  const { role } = z
    .object({ role: z.literal('member').default('member') })
    .parse(await context.req.json());

  const invitation = {
    id: crypto.randomUUID(),
    role,
    expiresAt: later(24 * 60),
    usedAt: null,
    revokedAt: null,
  };
  const value = token();
  const db = context.env.DB;
  await atomic(db, [
    adminCheck(db, actor.id),
    db
      .prepare(
        'INSERT INTO invitations(id,token_hash,role,created_by,expires_at) VALUES (?,?,?,?,?)',
      )
      .bind(invitation.id, await hash(value), role, actor.id, invitation.expiresAt),
  ]);
  return ok(context, { invitation, token: value });
});
invitations.delete('/:id', async (context) => {
  const actor = admin(context);
  const db = context.env.DB;
  const invitation = await db
    .prepare('SELECT role FROM invitations WHERE id=?')
    .bind(context.req.param('id'))
    .first<{ role: string }>();
  if (!invitation) fail('NOT_FOUND', '邀请不存在', 404);
  if (invitation!.role === 'admin') admin(context, true);
  await atomic(db, [
    adminCheck(db, actor.id, invitation!.role === 'admin'),
    db
      .prepare('UPDATE invitations SET revoked_at=COALESCE(revoked_at,?) WHERE id=?')
      .bind(beijingNow(), context.req.param('id')),
  ]);
  return ok(context, { ok: true });
});
