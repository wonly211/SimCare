import { readFileSync } from 'node:fs';
import { readConfiguration } from './cloudflare-build.mjs';
const config = readConfiguration(readFileSync('wrangler.jsonc', 'utf8'));
if (process.env.WORKERS_CI !== '1' && process.env.WORKERS_CI !== 'true')
  throw new Error('此检查仅用于 Workers Builds；本地使用 npm run build');
if (
  !config.keep_vars ||
  config.d1_databases?.[0]?.database_name !== config.name ||
  config.d1_databases?.[0]?.database_id === '00000000-0000-0000-0000-000000000001'
)
  throw new Error('自动部署配置尚未准备完成');
console.log('部署配置检查通过；控制台验收仍须单独完成。');
