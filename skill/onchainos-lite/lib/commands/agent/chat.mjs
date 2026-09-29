// agent chat commands — upstream commands/agent_commerce/chat/mod.rs (dispatched from
// agent_commerce/mod.rs after the per-invocation maintenance prelude).
import { typed } from '../../core/cli.mjs';
import { run as chatRun, ChatCommand } from '../../agent/chat/index.mjs';

const leaf = (uses, build) => ({
  uses,
  run: (ctx, o) => chatRun(build(o, ctx)),
});

export default {
  'agent file-upload': leaf(['file', 'agentId', 'jobId'], (o) => ({ kind: ChatCommand.FileUpload, file: o.file, agentId: o.agentId, jobId: o.jobId })),
  'agent file-download': leaf(['fileKey', 'agentId', 'output'], (o) => ({ kind: ChatCommand.FileDownload, fileKey: o.fileKey, agentId: o.agentId, output: o.output })),
  'agent sensitive-words': leaf([], () => ({ kind: ChatCommand.SensitiveWords })),
  'agent message-eligible': leaf([
    'agentId', 'clientAgentId', 'providerAgentId', 'jobId', 'groupId', 'direction', 'providerSecurityRate', 'clientCommunicationAddress',
    'providerCommunicationAddress', 'isOfflineReplay',
  ], (o, ctx) => ({
    kind: ChatCommand.MessageEligible, agentId: o.agentId, clientAgentId: o.clientAgentId, providerAgentId: o.providerAgentId, jobId: o.jobId,
    groupId: o.groupId, direction: o.direction, providerSecurityRate: o.providerSecurityRate, clientCommunicationAddress: o.clientCommunicationAddress,
    providerCommunicationAddress: o.providerCommunicationAddress, isOfflineReplay: typed(ctx.path, 'isOfflineReplay', o.isOfflineReplay, 'bool'),
  })),
  'agent system-config': leaf([], () => ({ kind: ChatCommand.SystemConfig })),
  'agent heartbeat': leaf(['chainIndex'], (o, ctx) => ({ kind: ChatCommand.Heartbeat, chainIndex: typed(ctx.path, 'chainIndex', o.chainIndex, 'u64') })),
  'agent wakeup-notify': leaf(['agentIds'], (o) => ({ kind: ChatCommand.WakeupNotify, agentIds: o.agentIds ?? [] })),
};
