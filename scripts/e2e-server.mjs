import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const cli = resolve('node_modules/wrangler/bin/wrangler.js');
const storage = resolve('.artifacts', `e2e-${randomUUID()}`);
const migration = spawnSync(
  process.execPath,
  [cli, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', storage],
  { stdio: 'inherit' },
);
if (migration.status !== 0) process.exit(migration.status ?? 1);
const child = spawn(
  process.execPath,
  [
    cli,
    'dev',
    '--port',
    '8877',
    '--persist-to',
    storage,
    '--var',
    'init_key:e2e-only-not-a-production-secret',
    '--var',
    'INIT_KEY:e2e-only-not-a-production-secret',
  ],
  { stdio: 'inherit' },
);
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
child.on('exit', (code) => process.exit(code ?? 0));
