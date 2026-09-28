// agent local-state / okx-a2a commands whose upstream handlers live in agent_commerce/mod.rs
// (inline wrappers) and task/common/{prefilled_*,deliverables,okx_a2a,funding_notice,
// session_cleanup,dispute_upload}.rs.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { UsageError } from '../../core/errors.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import * as prefilledNotify from '../../agent/task/common/prefilled-notify.mjs';
import * as prefilledRating from '../../agent/task/common/prefilled-rating.mjs';
import { handleSave, handleList, handleListAll } from '../../agent/task/common/deliverables.mjs';
import { userNotify } from '../../agent/task/common/okx-a2a.mjs';
import { execute as fundingNotice } from '../../agent/task/common/funding-notice.mjs';
import { handleSessionCleanup } from '../../agent/task/common/session-cleanup.mjs';
import { handleUploadEvidence } from '../../agent/task/common/dispute-upload.mjs';
import { ioErrorText } from '../../agent/_rs.mjs';

const ok = () => { process.stdout.write('OK\n'); return NO_OUTPUT; };

// FundingNoticeArgs.chain is a leaf-local required arg; core main.mjs forces the
// global `opts.chain = 'xlayer'` for every agent command, so recover the value
// the user actually typed after the `funding-notice` token (see requests).
function _localChain(argv) {
  if (!Array.isArray(argv)) return undefined;
  const start = argv.indexOf('funding-notice');
  if (start < 0) return undefined;
  let v;
  for (let i = start + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a === '--chain' && i + 1 < argv.length) { v = argv[++i]; continue; }
    if (a.startsWith('--chain=')) v = a.slice('--chain='.length);
  }
  return v;
}
// clap's PathBufValueParser rejects an empty value (`--image-path ""`) with the empty-value
// error (exit 2, no usage block). The core parser has no PathBuf type, so the two PathBuf
// args of these commands are checked here (see requests).
function pathBufNonEmpty(raw, display) {
  if (raw === '') throw new UsageError(`error: a value is required for '${display}' but none was supplied\n\nFor more information, try '--help'.\n`);
}
// `?` on a std::io::Error inside the handler → `{"ok":false,"error":"<io Display>"}`.
const io = (fn) => { try { return fn(); } catch (e) { if (e?.code && e?.syscall) throw new Error(ioErrorText(e)); throw e; } };

export default {
  'agent cache-notify': {
    uses: ['jobId', 'eventKey', 'content'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      io(() => prefilledNotify.save(o.jobId, o.eventKey, o.content));
      return ok();
    },
  },
  'agent cache-rating': {
    uses: ['jobId', 'score', 'comment'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      io(() => prefilledRating.save(o.jobId, o.score, o.comment));
      return ok();
    },
  },
  'agent task-deliverable-save': {
    uses: ['jobId', 'role', 'file', 'deliverableType', 'title', 'shortId', 'fileKey', 'tokenSymbol', 'tokenAmount', 'counterpartyAgentId', 'counterpartyName'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return io(() => handleSave({
        jobId: o.jobId, role: o.role, filePath: o.file, deliverableType: o.deliverableType, title: o.title, shortId: o.shortId,
        fileKey: o.fileKey, tokenSymbol: o.tokenSymbol, tokenAmount: o.tokenAmount, counterpartyAgentId: o.counterpartyAgentId, counterpartyName: o.counterpartyName,
      }));
    },
  },
  'agent task-deliverable-list': {
    uses: ['jobId', 'role', 'search'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return io(() => (o.jobId !== undefined ? handleList(o.jobId, o.role) : handleListAll(o.role, o.search)));
    },
  },
  'agent user-notify': {
    uses: ['content', 'imagePath'],
    async run(ctx, o) {
      pathBufNonEmpty(o.imagePath, '--image-path <IMAGE_PATH>');
      await runPreDispatchMaintenance();
      await userNotify(o.content, o.imagePath, true);
      return NO_OUTPUT;
    },
  },
  'agent funding-notice': {
    uses: ['chain', 'currency', 'shortfall', 'depositAddress', 'required', 'available', 'depositChain', 'reason', 'format', 'notifyUser', 'content', 'imageDir'],
    async run(ctx, o) {
      pathBufNonEmpty(o.imageDir, '--image-dir <IMAGE_DIR>');
      await runPreDispatchMaintenance();
      const reason = o.reason === 'payment402' ? 'payment-402' : o.reason;
      await fundingNotice({ ...o, chain: _localChain(ctx.argv) ?? o.chain, reason, notifyUser: !!o.notifyUser });
      return NO_OUTPUT;
    },
  },
  'agent session-cleanup': {
    uses: ['jobId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      await handleSessionCleanup(o.jobId, true);
      return NO_OUTPUT;
    },
  },
  'agent dispute upload': {
    uses: ['jobId', 'agentId', 'role', 'text', 'file', 'maxFiles'],
    label: 'agent dispute Discriminant(2)',
    async run(ctx, o) {
      const maxFiles = typed(ctx.path, 'maxFiles', o.maxFiles, 'usize');
      await runPreDispatchMaintenance();
      await handleUploadEvidence(new TaskApiClient(), o.jobId, o.agentId, o.role, o.text, o.file ?? [], maxFiles);
      return NO_OUTPUT;
    },
  },
};
