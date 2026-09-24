import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provision, cloudflareBuild, readConfiguration } from './cloudflare-build.mjs';
test('首次安装创建同名 D1 后迁移', async () => {
  const calls = [];
  const id = await provision({
    name: 'family-care',
    api: async (path, options) => {
      calls.push([path, options]);
      if (path.endsWith('/settings')) return null;
      if (path.includes('?')) return [];
      return { uuid: 'new-id', name: 'family-care' };
    },
    migrate: async (id) => calls.push(['migrate', id]),
  });
  assert.equal(id, 'new-id');
  assert.deepEqual(calls[2], ['/d1/database', { method: 'POST', body: { name: 'family-care' } }]);
  assert.deepEqual(calls[3], ['migrate', 'new-id']);
});
test('重复部署只复用已绑定 D1', async () => {
  const calls = [];
  await provision({
    name: 'family-care',
    api: async (path) => {
      calls.push(path);
      return path.endsWith('/settings')
        ? { bindings: [{ name: 'DB', type: 'd1', id: 'existing-id' }] }
        : { uuid: 'existing-id', name: 'family-care' };
    },
    migrate: async (id) => assert.equal(id, 'existing-id'),
  });
  assert.deepEqual(calls, ['/workers/scripts/family-care/settings', '/d1/database/existing-id']);
});
test('未绑定的同名 D1 不得接管', async () => {
  let migrated = false;
  await assert.rejects(
    provision({
      name: 'family-care',
      api: async (path) =>
        path.endsWith('/settings') ? null : [{ name: 'family-care', uuid: 'unrelated' }],
      migrate: async () => {
        migrated = true;
      },
    }),
    /拒绝自动接管/,
  );
  assert.equal(migrated, false);
});
test('迁移失败使安装失败，不返回可部署绑定', async () => {
  await assert.rejects(
    provision({
      name: 'family-care',
      api: async (path) =>
        path.endsWith('/settings')
          ? { bindings: [{ name: 'DB', type: 'd1', id: 'id' }] }
          : { uuid: 'id', name: 'family-care' },
      migrate: async () => {
        throw new Error('migration failed');
      },
    }),
    /migration failed/,
  );
});
test('权限错误不被当作资源不存在', async () => {
  let migrated = false;
  await assert.rejects(
    provision({
      name: 'family-care',
      api: async () => {
        throw new Error('403');
      },
      migrate: async () => {
        migrated = true;
      },
    }),
    /403/,
  );
  assert.equal(migrated, false);
});
test('本地安装没有远程副作用，预览和缺少平台凭据时停止', async () => {
  await cloudflareBuild({});
  await assert.rejects(cloudflareBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'preview' }), /main/);
  await assert.rejects(cloudflareBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' }), /未提供/);
});

test('Wrangler 配置支持 JSONC 注释和尾逗号', () => {
  assert.equal(readConfiguration('{ // comment\n "name":"family-care", }').name, 'family-care');
  assert.throws(() => readConfiguration('{ broken'), /格式无效/);
});
