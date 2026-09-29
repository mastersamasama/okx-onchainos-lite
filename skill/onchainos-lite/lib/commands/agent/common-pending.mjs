// agent pending-decisions-v2 — upstream task/common/pending_v2.rs (plain-text playbooks).
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import * as pv2 from '../../agent/task/common/pending-v2.mjs';

const LABEL = 'agent pending-decisions-v2';
const done = () => NO_OUTPUT;

export default {
  'agent pending-decisions-v2 request': {
    uses: ['jobId', 'role', 'agentId', 'toAgentId', 'userContent', 'userContentFile', 'listLabel', 'llmContent', 'sourceEvent', 'decisionId', 'choicesJson', 'expiresAt'],
    label: LABEL,
    async run(ctx, o) {
      const expiresAt = typed(ctx.path, 'expiresAt', o.expiresAt, 'i64');
      await pv2.handleRequestCommand({ ...o, expiresAt });
      return done();
    },
  },
  'agent pending-decisions-v2 request-prompt': {
    uses: ['jobId', 'role', 'agentId', 'toAgentId', 'userContent', 'userContentFile', 'listLabel', 'llmContent', 'sourceEvent', 'decisionId', 'choicesJson', 'expiresAt', 'templateVarsB64', 'refundDisplayB64'],
    label: LABEL,
    async run(ctx, o) {
      const expiresAt = typed(ctx.path, 'expiresAt', o.expiresAt, 'i64');
      await pv2.handleRequestPromptCommand({ ...o, expiresAt });
      return done();
    },
  },
  'agent pending-decisions-v2 resolve': {
    uses: ['userReply'],
    label: LABEL,
    async run(ctx, o) {
      await pv2.handleResolve(o.userReply);
      return done();
    },
  },
  'agent pending-decisions-v2 resolve-with-sessionkey': {
    uses: ['userReply', 'jobId', 'role', 'agentId', 'toAgentId', 'sourceEvent', 'decisionId', 'choicesJson', 'expiresAt', 'autotradeCandidateJson'],
    label: LABEL,
    async run(ctx, o) {
      const expiresAt = typed(ctx.path, 'expiresAt', o.expiresAt, 'i64');
      await pv2.handleResolveWithSessionkey({ ...o, expiresAt });
      return done();
    },
  },
  'agent pending-decisions-v2 resolve-prompt': {
    uses: ['userReply', 'jobId', 'role', 'agentId', 'toAgentId', 'sourceEvent', 'decisionId', 'autotradeCandidateJson'],
    label: LABEL,
    async run(ctx, o) {
      await pv2.handleResolvePrompt(o);
      return done();
    },
  },
  'agent pending-decisions-v2 pick': {
    uses: ['index', 'jobId'],
    label: LABEL,
    async run(ctx, o) {
      const index = typed(ctx.path, 'index', o.index, 'usize');
      await pv2.handlePick(index, o.jobId);
      return done();
    },
  },
  'agent pending-decisions-v2 list': {
    uses: ['format', 'scope'],
    label: LABEL,
    async run(ctx, o) {
      await pv2.handleList(o.format, o.scope);
      return done();
    },
  },
  'agent pending-decisions-v2 cancel': {
    uses: ['index'],
    label: LABEL,
    async run(ctx, o) {
      const index = typed(ctx.path, 'index', o.index, 'usize');
      await pv2.handleCancel(index);
      return done();
    },
  },
};
