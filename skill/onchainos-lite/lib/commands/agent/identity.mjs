// agent identity commands — upstream handlers in commands/agent_commerce/identity/
// (queries.rs, mutations.rs, service_match.rs, validate.rs), dispatched from
// agent_commerce/mod.rs after the per-invocation maintenance prelude.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { stringify } from '../../core/json.mjs';
import * as identity from '../../agent/identity/index.mjs';

// Every identity leaf: handler → data (printed as {"ok":true,"data":…}).
const leaf = (uses, call) => ({
  uses,
  async run(ctx, o) {
    return call(o, ctx);
  },
});

export default {
  'agent create': leaf(['name', 'role', 'description', 'picture', 'service'], (o) => identity.create(o)),
  'agent update': leaf(['agentId', 'name', 'description', 'picture', 'service'], (o) => identity.update(o)),
  'agent get': leaf(['agentIds', 'page', 'pageSize'], (o) => identity.get(o)),
  'agent get-my-agents': leaf(['role', 'ownerAddress', 'agentIds', 'page', 'pageSize'], (o) => identity.getMyAgents(o)),
  'agent get-agents': leaf(['agentIds'], (o) => identity.getAgents(o)),
  'agent pre-check': leaf(['role', 'consentKey'], (o) => identity.precheck(o)),
  'agent get-by-address': leaf(['communicationAddress', 'chainIndex'], (o) => identity.getByAddress(o)),
  'agent activate': leaf(['agentId', 'preferredLanguage'], (o) => identity.activate(o)),
  'agent deactivate': leaf(['agentId'], (o) => identity.deactivate(o)),
  'agent upload': leaf(['file'], (o) => identity.upload(o)),
  'agent search': leaf(['query', 'feedback', 'agentInfo', 'status', 'service', 'page', 'pageSize'], (o) => identity.search(o)),
  'agent service-list': leaf(['agentId', 'serviceId', 'page', 'pageSize'], (o) => identity.serviceList(o)),
  'agent service-match': {
    uses: ['keywords', 'aspAgentId', 'aspName', 'serviceName', 'sid', 'minPaymentTokenAmount', 'maxPaymentTokenAmount', 'searchAfter', 'limit'],
    async run(ctx, o) {
      const limit = typed(ctx.path, 'limit', o.limit, 'u64');
      return identity.serviceMatch({
        keywords: o.keywords ?? [], aspAgentId: o.aspAgentId, aspName: o.aspName, serviceName: o.serviceName, serviceId: o.sid,
        minPaymentTokenAmount: o.minPaymentTokenAmount, maxPaymentTokenAmount: o.maxPaymentTokenAmount, searchAfter: o.searchAfter, limit,
      });
    },
  },
  'agent feedback-submit': leaf(['agentId', 'creatorId', 'score', 'description', 'taskId'], (o) => identity.feedbackSubmit(o)),
  'agent feedback-list': leaf(['agentId', 'page', 'pageSize'], (o) => identity.feedbackList(o)),
  'agent task-feedback': leaf(['agentId', 'taskId'], (o) => identity.taskFeedback(o)),
  'agent xmtp-sign': leaf(['keyUuid', 'message'], (o) => identity.xmtpSign(o)),
  // Bespoke output: `println!("{}", serde_json::to_string_pretty(&result))`, always exit 0.
  'agent validate-listing': leaf(['role', 'name', 'description', 'service'], (o) => {
    process.stdout.write(stringify(identity.validateListing(o), true) + '\n');
    return NO_OUTPUT;
  }),
};
