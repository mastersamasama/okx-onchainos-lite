// agent read-only task queries + identity/route helpers whose upstream handlers live in
// task/common/{mod,query,lifecycle,in_progress}.rs.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import {
  AGENT_ROLE_USER, handleDesignatedRoute, handleMyAgents, handlePreflight, handleCommunicationCheck, handlePrepareCreate, handleProfile, runContext,
} from '../../agent/task/common/index.mjs';
import { handleStatus, handleList, handleActiveTasks } from '../../agent/task/common/query.mjs';
import { handleLifecycle } from '../../agent/task/common/lifecycle.mjs';
import { handleInProgress } from '../../agent/task/common/in-progress.mjs';

const print = (s) => { process.stdout.write(s); return NO_OUTPUT; };
const jsonOrText = (r) => (r.json !== undefined ? r.json : print(r.text));

export default {
  'agent status': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return jsonOrText(await handleStatus(new TaskApiClient(), o.jobId, o.agentId ?? '', AGENT_ROLE_USER));
    },
  },
  'agent lifecycle': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleLifecycle(new TaskApiClient(), o.jobId, o.agentId ?? '');
    },
  },
  'agent tasks': {
    uses: ['status', 'page', 'limit', 'agentId'],
    async run(ctx, o) {
      const page = typed(ctx.path, 'page', o.page, 'u32');
      const limit = typed(ctx.path, 'limit', o.limit, 'u32');
      await runPreDispatchMaintenance();
      return jsonOrText(await handleList(new TaskApiClient(), o.status, page, limit, o.agentId ?? '', AGENT_ROLE_USER));
    },
  },
  'agent active-tasks': {
    uses: ['role', 'includeTerminal'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleActiveTasks(new TaskApiClient(), o.role, !!o.includeTerminal);
    },
  },
  'agent designated-route': {
    uses: ['provider', 'serviceId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleDesignatedRoute(o.provider, o.serviceId);
    },
  },
  'agent my-agents': {
    uses: ['role'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleMyAgents(o.role);
    },
  },
  'agent gate-check': {
    uses: ['role'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handlePreflight(o.role);
    },
  },
  'agent communication-check': {
    uses: [],
    async run() {
      await runPreDispatchMaintenance();
      return handleCommunicationCheck();
    },
  },
  'agent prepare-create': {
    uses: ['description', 'title', 'budget', 'maxBudget', 'currency', 'provider'],
    async run(ctx, o) {
      const budget = typed(ctx.path, 'budget', o.budget, 'f64');
      const maxBudget = typed(ctx.path, 'maxBudget', o.maxBudget, 'f64');
      await runPreDispatchMaintenance();
      return handlePrepareCreate(o.description, o.title, budget, maxBudget, o.currency, o.provider);
    },
  },
  'agent profile': {
    uses: ['agentId'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleProfile(o.agentId);
    },
  },
  'agent common context': {
    uses: ['jobId', 'role', 'agentId'],
    label: 'agent common Discriminant(0)',
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return print(`${await runContext(o.jobId, o.role, o.agentId)}\n`);
    },
  },
  'agent task-in-progress': {
    uses: ['agentIds'],
    async run(ctx, o) {
      await runPreDispatchMaintenance();
      return handleInProgress(new TaskApiClient(), o.agentIds ?? []);
    },
  },
};
