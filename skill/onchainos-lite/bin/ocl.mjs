#!/usr/bin/env node
// onchainos-lite entry point: `node bin/ocl.mjs <args>` behaves like `onchainos <args>`.
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  process.stdout.write(JSON.stringify({ ok: false, error: `onchainos-lite needs Node.js >= 18 (found ${process.versions.node})` }) + '\n');
  process.exit(1);
}
const { main } = await import('../lib/core/main.mjs');
await main(process.argv.slice(2));
