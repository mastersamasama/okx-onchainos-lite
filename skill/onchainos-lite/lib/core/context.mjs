// Per-invocation context handed to every handler — upstream commands::Context.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homePath, writeAtomic } from './home.mjs';
import { ApiClient, setDevMode } from './http.mjs';
import { resolveChain } from './chains.mjs';

export const NO_OUTPUT = Symbol('ocl.noOutput');   // handler printed its own output
export const EMPTY = Symbol('ocl.empty');          // print {"ok":true}

// config::AppConfig — only default_chain is consumed.
export function loadAppConfig() {
  const path = homePath('config.json');
  const legacy = join(process.cwd(), '.onchainos', 'config.json');
  if (!existsSync(path) && existsSync(legacy)) {
    try { writeAtomic(path, readFileSync(legacy), { mode: 0o644 }); } catch {}
    process.stderr.write(`Migrated config from ${legacy} to ${path}. You can safely delete the stale .onchainos directory at ${join(process.cwd(), '.onchainos')}.\n`);
  }
  const def = { api_key: '', session_token: '', active_wallet: '', default_chain: '' };
  if (!existsSync(path)) return def;
  try { return { ...def, ...JSON.parse(readFileSync(path, 'utf8')) }; } catch { return def; }
}

export function createContext({ path, opts, argv }) {
  if (opts.dev) setDevMode(true);
  let config;
  let client;
  const ctx = {
    path, opts, argv,
    get config() { return (config ??= loadAppConfig()); },
    get chainOverride() { return opts.chain ?? undefined; },

    // Context::client_async — JWT lifecycle (refresh when expired).
    api: () => (client ??= ApiClient.create()),
    // Context::client — sync auth (no expiry check).
    apiSync: () => ApiClient.sync(),

    chainIndex() {
      const c = ctx.chainOverride ?? (ctx.config.default_chain || undefined);
      return c === undefined ? undefined : resolveChain(c);
    },
    chainIndexOr(def) { return ctx.chainIndex() ?? resolveChain(def); },
    resolveChainsOr(explicit, def) {
      if (explicit !== undefined && explicit !== null) return explicit;
      if (ctx.chainOverride !== undefined) return resolveChain(ctx.chainOverride);
      return def;
    },
  };
  return ctx;
}
