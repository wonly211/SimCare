import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authenticate, auth } from './auth';
import { apiError, fail, Fault, ok, type AppEnv } from './core';
import { invitations, members, permissions } from './members';
import { records, sync } from './records';
import { backups } from './backups';

export const app = new Hono<AppEnv>();
app.use('/api/*', async (context, next) => {
  context.set('requestId', crypto.randomUUID());
  context.header('Cache-Control', 'no-store');
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Referrer-Policy', 'no-referrer');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) &&
    context.req.header('Origin') !== new URL(context.req.url).origin
  )
    fail('ORIGIN_INVALID', '请求来源不受信任', 403);
  if (context.req.header('Sec-Fetch-Site') === 'cross-site')
    fail('ORIGIN_INVALID', '拒绝跨站请求', 403);
  await next();
  context.header('X-Request-ID', context.get('requestId'));
});
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 8 * 1024 * 1024,
    onError: (context) =>
      context.json(
        {
          success: false,
          data: null,
          error: { code: 'BODY_TOO_LARGE', message: '请求内容过大' },
          request_id: context.get('requestId'),
        },
        413,
      ),
  }),
);
app.get('/api/v1/health', (context) => ok(context, { status: 'ok' }));
app.route('/api/v1/auth', auth);
app.use('/api/v1/*', async (context, next) => {
  await authenticate(context);
  await next();
});
app.route('/api/v1/members', members);
app.route('/api/v1/permissions', permissions);
app.route('/api/v1/invitations', invitations);
app.route('/api/v1/sync', sync);
app.route('/api/v1/backups', backups);
app.route('/api/v1', records);
app.notFound((context) =>
  context.json(
    {
      success: false,
      data: null,
      error: { code: 'NOT_FOUND', message: '接口不存在' },
      request_id: context.get('requestId'),
    },
    404,
  ),
);
app.onError((error, context) => {
  if (
    !(error instanceof Fault) &&
    !(error instanceof z.ZodError) &&
    !(error instanceof SyntaxError)
  )
    console.error(
      JSON.stringify({
        request_id: context.get('requestId'),
        operation: 'api_request',
        category: 'INTERNAL',
      }),
    );
  if (error instanceof z.ZodError)
    return context.json(
      {
        success: false,
        data: null,
        error: { code: 'VALIDATION', message: '请求字段无效', details: error.issues },
        request_id: context.get('requestId'),
      },
      400,
    );
  if (error instanceof SyntaxError)
    return context.json(
      {
        success: false,
        data: null,
        error: { code: 'VALIDATION', message: 'JSON 格式无效' },
        request_id: context.get('requestId'),
      },
      400,
    );
  return context.json(
    { success: false, data: null, error: apiError(error), request_id: context.get('requestId') },
    (error instanceof Fault ? error.status : 500) as 400 | 401 | 403 | 404 | 409 | 500,
  );
});
export default app;
