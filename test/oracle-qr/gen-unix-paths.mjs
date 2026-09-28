#!/usr/bin/env node
// Unix-flavour std::path vectors for lib/core/qr.mjs, from the real std path code:
//   cd test/oracle-qr/unix-paths && cargo build --release --offline --target wasm32-unknown-unknown
//   node test/oracle-qr/gen-unix-paths.mjs
// writes test/oracle-qr/vectors-paths-unix.json ({paths, pairs}; see src/pathops.rs).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const wasm = join(HERE, 'unix-paths', 'target', 'wasm32-unknown-unknown', 'release', 'oracle_qr_unix_paths.wasm');
const { instance } = await WebAssembly.instantiate(readFileSync(wasm), {});
const ptr = instance.exports.generate();
const len = instance.exports.out_len();
const text = Buffer.from(new Uint8Array(instance.exports.memory.buffer, ptr, len)).toString('utf8');
const doc = JSON.parse(text);
const lines = ['{', `  "generator": "test/oracle-qr/unix-paths (std sys/path/unix.rs via wasm32-unknown-unknown)",`];
for (const key of ['paths', 'pairs']) {
  lines.push(`  "${key}": [`);
  doc[key].forEach((v, i) => lines.push(`    ${JSON.stringify(v)}${i + 1 < doc[key].length ? ',' : ''}`));
  lines.push(key === 'paths' ? '  ],' : '  ]');
}
lines.push('}', '');
const out = join(HERE, 'vectors-paths-unix.json');
writeFileSync(out, lines.join('\n'));
console.error(`wrote ${out} (${doc.paths.length} paths, ${doc.pairs.length} pairs)`);
