import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export function readConfiguration(source) {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', source);
  if (parsed.error) throw new Error('wrangler.jsonc 格式无效');
  return parsed.config;
}

// Injected dependencies make provisioning and failure paths testable without a cloud account.
export async function provision({ name, api, migrate }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Worker 项目名无效');
  const settings = await api(`/workers/scripts/${name}/settings`, { allow404: true });
  const bound = settings?.bindings?.find((binding) => binding.name === 'DB');
  let database;
  if (bound) {
    if (bound.type !== 'd1' || !bound.id) throw new Error('现有 DB 绑定不是有效 D1，停止部署');
    database = await api(`/d1/database/${bound.id}`);
    if (database.name !== name) throw new Error('已绑定数据库与项目不同名，停止部署以保留原数据');
  } else {
    const existing = await api(`/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
    if (existing.some((database) => database.name === name))
      throw new Error('存在未绑定的同名 D1，拒绝自动接管；请维护者检查此前部署');
    database = await api('/d1/database', { method: 'POST', body: { name } });
  }
  if (!database?.uuid) throw new Error('D1 未返回有效 ID');
  await migrate(database.uuid);
  return database.uuid;
}
export async function cloudflareBuild(env = process.env) {
  if (env.WORKERS_CI !== '1' && env.WORKERS_CI !== 'true') return;
  if (env.WORKERS_CI_BRANCH !== 'main')
    throw new Error('自动安装仅允许 main 分支；预览构建不得连接正式 D1');
  const name = env.WRANGLER_CI_OVERRIDE_NAME;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const credential = env.CLOUDFLARE_API_TOKEN;
  if (!name || !account || !credential)
    throw new Error(
      'Workers Builds 未提供项目名、账号或部署凭据；停止安装，不要求用户把 API token 写入应用变量',
    );
  const config = readConfiguration(await readFile('wrangler.jsonc', 'utf8'));
  const marker = resolve('.wrangler/cloud-build-ready.json');
  try {
    const ready = JSON.parse(await readFile(marker, 'utf8'));
    if (
      ready.name === name &&
      ready.commit === env.WORKERS_CI_COMMIT_SHA &&
      config.d1_databases?.[0]?.database_id === ready.id
    )
      return;
  } catch {
    /* fresh build */
  }
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
    if (result.status !== 0) throw new Error('构建或迁移失败，未发布 Worker');
  };
  // No shell interpolation and no credentials in command arguments or logs.
  run(['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts']);
  const api = async (path, options = {}) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}${path}`,
      {
        method: options.method ?? 'GET',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
      },
    );
    if (options.allow404 && response.status === 404) return null;
    const data = await response.json();
    if (!response.ok || !data.success)
      throw new Error(
        `Cloudflare 资源操作失败（HTTP ${response.status}），检查 Builds 自动令牌的 Worker/D1 权限`,
      );
    return data.result;
  };
  const id = await provision({
    name,
    api,
    migrate: async (id) => {
      config.name = name;
      config.keep_vars = true;
      delete config.vars;
      delete config.env;
      delete config.routes;
      config.d1_databases = [
        { binding: 'DB', database_name: name, database_id: id, migrations_dir: 'db/migrations' },
      ];
      await writeFile('wrangler.jsonc', JSON.stringify(config, null, 2) + '\n');
      run(['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--remote']);
    },
  });
  const { mkdir } = await import('node:fs/promises');
  await mkdir('.wrangler', { recursive: true });
  await writeFile(marker, JSON.stringify({ name, id, commit: env.WORKERS_CI_COMMIT_SHA }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await cloudflareBuild();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
