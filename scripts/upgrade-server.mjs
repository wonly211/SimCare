import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
const folder = resolve('.artifacts', 'upgrade-' + randomUUID());
await mkdir(folder, { recursive: true });
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw Error('Upgrade fixture command failed: ' + command);
  return result;
};
const vite = resolve('node_modules/vite/bin/vite.js');
const snapshots = Object.fromEntries(
  ['a', 'b', 'legacy'].map((name) => [name, join(folder, name)]),
);
for (const name of ['a', 'b'])
  run(process.execPath, [
    vite,
    'build',
    '--config',
    'apps/web/vite.config.ts',
    '--outDir',
    snapshots[name],
  ]);
// Use the real released input, not a hand-written imitation of the old worker.
const legacySource = join(folder, 'legacy-source');
await mkdir(legacySource, { recursive: true });
const archive = spawnSync(
  'git',
  ['-C', process.env.SIMCARE_TEST_SOURCE_REPO || process.cwd(), 'archive', 'v0.1.1'],
  { maxBuffer: 32 * 1024 * 1024 },
);
if (archive.status !== 0)
  throw Error(
    'The v0.1.1 tag is required for the migration test; fetch tags before running this suite.',
  );
run('tar', ['-xf', '-', '-C', legacySource], {
  input: archive.stdout,
  stdio: ['pipe', 'inherit', 'inherit'],
});
run(
  process.execPath,
  [vite, 'build', '--config', 'apps/web/vite.config.ts', '--outDir', snapshots.legacy],
  { cwd: legacySource },
);
run(process.execPath, [
  resolve('node_modules/wrangler/bin/wrangler.js'),
  'deploy',
  '--dry-run',
  '--outdir',
  join(folder, 'worker'),
]);
const options = (name) => ({
  modules: true,
  scriptPath: join(folder, 'worker/index.js'),
  compatibilityDate: '2026-07-22',
  compatibilityFlags: ['nodejs_compat'],
  bindings: { init_key: 'upgrade-only-test-key' },
  d1Databases: { DB: 'upgrade-test' },
  d1Persist: join(folder, 'd1'),
  assets: {
    directory: snapshots[name],
    binding: 'ASSETS',
    routerConfig: { has_user_worker: true, static_routing: { user_worker: ['/api/*'] } },
    assetConfig: { not_found_handling: 'single-page-application' },
  },
});
const runtime = new Miniflare(options('a'));
const db = await runtime.getD1Database('DB');
for (const name of (await readdir('db/migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()) {
  const sql = await readFile(join('db/migrations', name), 'utf8');
  for (const statement of sql
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean))
    await db.prepare(statement).run();
}
let failedAssets = false;
const versions = {
  a: JSON.parse(await readFile(join(snapshots.a, 'version.json'), 'utf8')),
  b: JSON.parse(await readFile(join(snapshots.b, 'version.json'), 'utf8')),
};
const application = createServer(async (request, response) => {
  try {
    if (failedAssets && request.url?.startsWith('/assets/')) {
      response.writeHead(503);
      response.end('test download failure');
      return;
    }
    const parts = [];
    for await (const part of request) parts.push(part);
    const result = await runtime.dispatchFetch('http://localhost:8899' + request.url, {
      method: request.method,
      headers: request.headers,
      ...(parts.length ? { body: Buffer.concat(parts) } : {}),
    });
    response.statusCode = result.status;
    result.headers.forEach((value, key) => {
      if (key !== 'set-cookie') response.setHeader(key, value);
    });
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader('set-cookie', cookies);
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    console.error(error);
    response.writeHead(500);
    response.end('test server error');
  }
});
const control = createServer(async (request, response) => {
  try {
    if (request.method === 'POST') {
      const parts = [];
      for await (const part of request) parts.push(part);
      const command = JSON.parse(Buffer.concat(parts).toString());
      if (!Object.hasOwn(snapshots, command.version)) throw Error('Unknown fixture');
      failedAssets = !!command.failedAssets;
      await runtime.setOptions(options(command.version));
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(versions));
  } catch (error) {
    console.error(error);
    response.writeHead(500);
    response.end('test control error');
  }
});
application.listen(8899, '127.0.0.1');
control.listen(8900, '127.0.0.1');
async function close() {
  application.close();
  control.close();
  await runtime.dispose();
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
