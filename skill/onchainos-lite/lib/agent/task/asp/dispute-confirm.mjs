// Retired `dispute confirm` compatibility entrypoint — upstream task/asp/dispute_confirm.rs.
// It validates its inputs and always fails before any API or on-chain write.
import { context } from '../../../core/errors.mjs';
import { trim, charCount, utf8ErrorText } from '../../../core/rs/str.mjs';
import { B64 } from '../../../core/rs/codec.mjs';

const MAX_REASON_CHARS = 2000;

// upstream: dispute_confirm.rs::decode_reason_input → reason string
export function decodeReasonInput(reason, reasonB64) {
  const hasR = reason !== undefined && reason !== null, hasB = reasonB64 !== undefined && reasonB64 !== null;
  if (hasR && hasB) throw new Error('Pass exactly one of --reason or --reason-b64');
  if (hasR) return String(reason);
  if (hasB) {
    let bytes;
    try { bytes = B64.URL_SAFE_NO_PAD.decode(reasonB64); } catch (e) { throw context('--reason-b64 is not valid URL-safe base64', e); }
    const bad = utf8ErrorText(bytes);
    if (bad !== undefined) throw context('--reason-b64 does not contain UTF-8 text', new Error(bad));
    return bytes.toString('utf8');
  }
  throw new Error('Evaluation reason is required. Pass --reason or --reason-b64.');
}

// upstream: dispute_confirm.rs::handle_dispute_confirm — always an error
export async function handleDisputeConfirm(_client, _jobId, reason, agentId) {
  if (agentId === '') throw new Error("--agent-id is required (pass the ASP's own agentId; beta backend rejects empty agenticId header)");
  if (trim(reason) === '') throw new Error('Evaluation reason is required. Pass the original evaluation reason with --reason or --reason-b64.');
  if (charCount(reason) > MAX_REASON_CHARS) throw new Error(`Evaluation reason exceeds ${MAX_REASON_CHARS} characters. Please shorten it and try again.`);
  throw new Error('dispute confirm has been retired. Use `onchainos agent dispute raise <jobId> --reason <reason> --agent-id <aspAgentId>`; it completes approve and evaluation creation in one transaction');
}
