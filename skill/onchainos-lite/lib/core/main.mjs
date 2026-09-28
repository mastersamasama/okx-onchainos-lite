// Process driver: parse → dispatch → print → exit code. Mirrors upstream main.rs.
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { parse } from './cli.mjs';
import * as out from './output.mjs';
import * as E from './errors.mjs';
import { createContext, NO_OUTPUT, EMPTY } from './context.mjs';
import { UPSTREAM_VERSION } from '../config.mjs';
import { auditLog, redactArgs, commandLabel } from './audit.mjs';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

// Handlers live in lib/commands/<top-level>/*.mjs; every file default-exports
// { 'full command path': { uses, run } }. Files starting with "_" are helpers.
export async function loadHandlers(top) {
  const dir = join(COMMANDS_DIR, top);
  const map = {};
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')); } catch {}
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    Object.assign(map, mod.default || {});
  }
  return map;
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (e) {
    if (e instanceof E.UsageError) { process.stderr.write(e.message); process.exit(2); }
    throw e;
  }
  if (parsed.version) { process.stdout.write(`onchainos ${UPSTREAM_VERSION}\n`); return; }
  if (parsed.help !== undefined) {
    if (parsed.missingSubcommand) { process.stderr.write(parsed.help); process.exit(2); }
    process.stdout.write(parsed.help);
    return;
  }

  const { path, opts } = parsed;
  const top = path.split(' ')[0];
  // upstream forces the global --chain to X Layer for every agent subcommand (a leaf's own
  // --chain, e.g. funding-notice, is a separate clap arg and keeps its value)
  if (top === 'agent' && !parsed.node.opts.some((o) => o.name === 'chain' && !o.global)) opts.chain = 'xlayer';

  const handlers = await loadHandlers(top);
  const handler = handlers[path];
  if (!handler) {
    out.error(`onchainos-lite: '${path}' is not implemented yet`);
    process.exit(1);
  }

  const ctx = createContext({ path, opts, argv });
  if (top !== 'mcp') void ctx.config;   // Context::new loads AppConfig eagerly (incl. legacy ./.onchainos migration notice)
  const start = process.hrtime.bigint();
  let result, error;
  try {
    result = await handler.run(ctx, opts);
  } catch (e) {
    error = e;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  // clap value-parser errors raised inside a handler (typed()) exit before upstream's audit::log
  if (top !== 'mcp' && !(error instanceof E.UsageError)) auditLog('cli', handler.label ?? commandLabel(path), !error, elapsedMs, redactArgs(['onchainos', ...argv]), error ? errorText(error) : undefined);
  await ctx.close?.();

  if (!error) {
    if (result === NO_OUTPUT) return;
    if (result === EMPTY) out.successEmpty();
    else out.success(result);
    return;
  }
  process.exit(report(error));
}

export const errorText = (e) => (e && e.message !== undefined ? e.message : String(e));

// Print an error the way upstream main.rs does and return the exit code.
export function report(e) {
  if (e instanceof E.WalletPreviewConfirming) { out.walletConfirming(e.msg, e.next, e.scene, e.preview); return 2; }
  if (e instanceof E.Confirming) { out.confirming(e.msg, e.next, e.scene); return 2; }
  if (e instanceof E.SetupRequired) { out.setupRequired(e.errorCode, e.msg, e.data); return 3; }
  if (e instanceof E.BespokeExit) return e.code;
  if (e instanceof E.FundingBlocked || e instanceof E.DuplicateSubscription) { out.errorData(e.data); return 1; }
  if (e instanceof E.CodedError) { out.errorCoded(e.code, e.field, e.message, e.data, e.nextSteps); return 1; }
  if (e instanceof E.InsufficientBalance) { out.insufficientBalance({ message: e.message, ...e }); return 1; }
  if (e instanceof E.UsageError) { process.stderr.write(e.message); return 2; }
  if (process.env.OCL_DEBUG === '1' && e?.stack) process.stderr.write(e.stack + '\n');
  out.error(errorText(e));
  return 1;
}
