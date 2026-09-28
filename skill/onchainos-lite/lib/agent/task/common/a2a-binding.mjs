// Job-provider runtime binding via okx-a2a — upstream task/common/a2a_binding.rs.
import { parse as parseJson } from '../../../core/json.mjs';
import { output, utf8Lossy } from '../../_proc.mjs';
import { get, asStr, asBool, trim, spawnErrorText, exitCodeDebug } from '../../_rs.mjs';

const OKX_A2A = 'okx-a2a';
const COMMAND_TIMEOUT_MS = 3000;

// upstream: a2a_binding.rs::run_okx_a2a → output | throws the String error text
async function runOkxA2a(args) {
  const o = await output(OKX_A2A, args, { timeoutMs: COMMAND_TIMEOUT_MS });
  if (o.spawnError) throw new Error(`spawn \`${OKX_A2A}\` failed: ${spawnErrorText(o.spawnError)}`);
  if (o.timedOut) throw new Error(`\`${OKX_A2A} ${args.join(' ')}\` timed out`);
  return o;
}

const isTruthyEnv = (key) => { const v = process.env[key]; return v !== undefined && ['1', 'true', 'yes', 'on'].includes(trim(v).toLowerCase()); };

// upstream: a2a_binding.rs::JobProviderPreBind
export class JobProviderPreBind {
  constructor(jobId, provider, created) { this.jobId = jobId; this.provider = provider; this.created = created; }
  // upstream: JobProviderPreBind::rollback_if_created
  async rollbackIfCreated() {
    if (!this.created || this.jobId === '' || this.provider === '') return;
    try {
      const o = await runOkxA2a(['job-provider', 'unset', '--job-id', this.jobId, '--provider', this.provider, '--json']);
      if (o.code === 0) process.stderr.write(`[a2a-binding] rolled back pre-broadcast job provider binding: jobId=${this.jobId} provider=${this.provider}\n`);
      else process.stderr.write(`[a2a-binding] WARN: rollback failed: jobId=${this.jobId} provider=${this.provider} exit=${exitCodeDebug(o.code)} stderr=${trim(utf8Lossy(o.stderr))} stdout=${trim(utf8Lossy(o.stdout))}\n`);
    } catch (e) {
      process.stderr.write(`[a2a-binding] WARN: rollback unavailable: jobId=${this.jobId} provider=${this.provider}: ${e.message}\n`);
    }
  }
}

// upstream: a2a_binding.rs::bind_job_provider_to_current_runtime → binding | undefined
export async function bindJobProviderToCurrentRuntime(jobId) {
  try { return await bindJobProviderToCurrentRuntimeRequired(jobId); } catch (e) {
    process.stderr.write(`[a2a-binding] WARN: ${e.message}\n`);
    return undefined;
  }
}

// upstream: a2a_binding.rs::bind_job_provider_to_current_runtime_required
export async function bindJobProviderToCurrentRuntimeRequired(jobIdRaw) {
  const jobId = trim(jobIdRaw);
  if (jobId === '' || jobId === '?') throw new Error('job-provider bind-current requires a valid jobId');
  if (isTruthyEnv('OKX_A2A_DISABLE_JOB_PROVIDER_BINDING')) throw new Error('job-provider binding is disabled by OKX_A2A_DISABLE_JOB_PROVIDER_BINDING');
  let o;
  try { o = await runOkxA2a(['job-provider', 'bind-current', '--job-id', jobId, '--json']); } catch (e) {
    throw new Error(`okx-a2a job-provider bind-current unavailable for jobId=${jobId}: ${e.message}`);
  }
  if (o.code === 0) {
    let value;
    try { value = parseJson(utf8Lossy(o.stdout)); } catch { value = undefined; }
    if (value !== undefined) {
      const provider = asStr(get(value, 'provider')) ?? 'unknown';
      const created = asBool(get(value, 'created')) ?? false;
      process.stderr.write(`[a2a-binding] job provider bind-current ok: jobId=${jobId} provider=${provider} created=${created}\n`);
      if (provider !== 'unknown') return new JobProviderPreBind(jobId, provider, created);
    }
    throw new Error(`okx-a2a job-provider bind-current returned no provider for jobId=${jobId}`);
  }
  throw new Error(`okx-a2a job-provider bind-current failed: jobId=${jobId} exit=${exitCodeDebug(o.code)} stderr=${trim(utf8Lossy(o.stderr))} stdout=${trim(utf8Lossy(o.stdout))}`);
}
