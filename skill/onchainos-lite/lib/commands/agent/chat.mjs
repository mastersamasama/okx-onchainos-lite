// agent chat commands — upstream commands/agent_commerce/chat/mod.rs (dispatched from
// agent_commerce/mod.rs after the per-invocation maintenance prelude).
import { typed } from '../../core/cli.mjs';
import { runPreDispatchMaintenance } from '../../agent/index.mjs';
import { run as chatRun, ChatCommand } from '../../agent/chat/index.mjs';

// clap BoolishValueParser (`--is-offline-replay <BOOL>`): y|yes|t|true|on|1 / n|no|f|false|off|0.
const BOOLISH_TRUE = ['y', 'yes', 't', 'true', 'on', '1'];
const boolish = (v) => (v === undefined || v === null ? undefined : BOOLISH_TRUE.includes(String(v).toLowerCase()));

const leaf = (uses, build) => ({
  uses,
  async run(ctx, o) {
    const cmd = build(o, ctx);
    await runPreDispatchMaintenance();
    return chatRun(cmd);
  },
});

export default {
  'agent file-upload': leaf(['file', 'agentId', 'jobId'], (o) => ({ kind: ChatCommand.FileUpload, file: o.file, agentId: o.agentId, jobId: o.jobId })),
  'agent file-download': leaf(['fileKey', 'agentId', 'output'], (o) => ({ kind: ChatCommand.FileDownload, fileKey: o.fileKey, agentId: o.agentId, output: o.output })),
  'agent sensitive-words': leaf([], () => ({ kind: ChatCommand.SensitiveWords })),
  'agent message-eligible': leaf([
    'agentId', 'clientAgentId', 'providerAgentId', 'jobId', 'groupId', 'direction', 'providerSecurityRate', 'clientCommunicationAddress',
    'providerCommunicationAddress', 'isOfflineReplay',
  ], (o) => ({
    kind: ChatCommand.MessageEligible, agentId: o.agentId, clientAgentId: o.clientAgentId, providerAgentId: o.providerAgentId, jobId: o.jobId,
    groupId: o.groupId, direction: o.direction, providerSecurityRate: o.providerSecurityRate, clientCommunicationAddress: o.clientCommunicationAddress,
    providerCommunicationAddress: o.providerCommunicationAddress, isOfflineReplay: boolish(o.isOfflineReplay),
  })),
  'agent system-config': leaf([], () => ({ kind: ChatCommand.SystemConfig })),
  'agent heartbeat': leaf(['chainIndex'], (o, ctx) => ({ kind: ChatCommand.Heartbeat, chainIndex: typed(ctx.path, 'chainIndex', o.chainIndex, 'u64') })),
  'agent wakeup-notify': leaf(['agentIds'], (o) => ({ kind: ChatCommand.WakeupNotify, agentIds: o.agentIds ?? [] })),
};
