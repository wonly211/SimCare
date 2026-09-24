import { spawnSync } from 'node:child_process';
import { cloudflareBuild } from './cloudflare-build.mjs';
if (process.env.WORKERS_CI !== '1' && process.env.WORKERS_CI !== 'true') {
  console.error(
    '正式部署请使用 Cloudflare Workers Builds 连接 main 分支；本地验证使用 npm run build。',
  );
  process.exit(1);
}
await cloudflareBuild();
const auth = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'whoami'], {
  stdio: 'inherit',
});
if (auth.status !== 0) process.exit(auth.status ?? 1);
const result = spawnSync(
  process.execPath,
  ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--keep-vars'],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
