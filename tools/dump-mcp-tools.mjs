#!/usr/bin/env node
// Capture the upstream MCP tool catalogue (`onchainos mcp` → tools/list) verbatim into
// skill/onchainos-lite/lib/mcp-tools.json, so lite serves byte-identical tool schemas.
//   node tools/dump-mcp-tools.mjs <onchainos-binary>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.argv[2];
if (!BIN) { console.error('usage: dump-mcp-tools.mjs <onchainos-binary>'); process.exit(2); }

const p = spawn(BIN, ['mcp'], { env: { ...process.env, ONCHAINOS_HOME: mkdtempSync(join(tmpdir(), 'ocl-mcp-')) }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
p.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    waiters.get(msg.id)?.(msg);
  }
});
const call = (id, method, params) => new Promise((resolve) => {
  waiters.set(id, resolve);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dump', version: '0' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await call(2, 'tools/list', {});
p.stdin.end();
const out = { upstream: init.result.serverInfo.version, protocolVersion: init.result.protocolVersion, initialize: init.result, tools: list.result.tools };
writeFileSync(join(ROOT, 'skill', 'onchainos-lite', 'lib', 'mcp-tools.json'), JSON.stringify(out));
console.log(`mcp-tools.json: ${out.tools.length} tools (upstream ${out.upstream}, protocol ${out.protocolVersion})`);
