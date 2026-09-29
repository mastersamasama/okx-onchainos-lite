// agent user-side (buyer) commands whose upstream handlers live in task/user/{mod,create,
// create_subscribe,task_create_prepare,service_detail,service_param_update,negotiate,
// device_routing,offline_receive,accept,reject_apply,visibility,my_tasks,query,attachments}.rs.
import { typed } from '../../core/cli.mjs';
import { NO_OUTPUT } from '../../core/context.mjs';
import { TaskApiClient } from '../../agent/task/common/network/task-api-client.mjs';
import { ioErrorText } from '../../core/rs/fs.mjs';
import { parseBoolOrInt, handleSubscriptionExecutionConfigSet } from '../../agent/task/user/index.mjs';
import { handleCreate } from '../../agent/task/user/create.mjs';
import { handleCreateSubscribe } from '../../agent/task/user/create-subscribe.mjs';
import { handleServiceDetail } from '../../agent/task/user/service-detail.mjs';
import { handleTaskCreatePrepare } from '../../agent/task/user/task-create-prepare.mjs';
import { handle as handleServiceParamUpdate } from '../../agent/task/user/service-param-update.mjs';
import { markFailed } from '../../agent/task/user/negotiate.mjs';
import { handleDeviceList, handleSubscribeDeviceUpdate } from '../../agent/task/user/device-routing.mjs';
import { handleSubscribeOfflineUpdate } from '../../agent/task/user/offline-receive.mjs';
import { handleSetPaymentMode, handleConfirmAccept } from '../../agent/task/user/accept.mjs';
import { handleRejectApply } from '../../agent/task/user/reject-apply.mjs';
import { handleTaskVisibilityUpdate } from '../../agent/task/user/visibility.mjs';
import { handleMyTasks } from '../../agent/task/user/my-tasks.mjs';
import { handlePayment } from '../../agent/task/user/query.mjs';
import { handleTaskAttach, handleTaskAttachments } from '../../agent/task/user/attachments.mjs';

// `?` on a std::io::Error inside the handler → `{"ok":false,"error":"<io Display>"}`.
const io = (fn) => { try { return fn(); } catch (e) { if (e?.code && e?.syscall) throw new Error(ioErrorText(e)); throw e; } };

export default {
  'agent create-task': {
    uses: ['title', 'description', 'descriptionSummary', 'providerAgentId', 'paymentTokenSymbol', 'paymentTokenAmount', 'file', 'serviceId', 'serviceParams',
      'serviceTokenAddress', 'serviceTokenAmount', 'categoryCode', 'minCreditScore', 'visibility', 'chainId', 'serviceGuide', 'serviceGuideHash', 'guideConsentJson'],
    async run(ctx, o) {
      const minCreditScore = typed(ctx.path, 'minCreditScore', o.minCreditScore, 'f64');
      return handleCreate(new TaskApiClient(), {
        title: o.title, description: o.description, descriptionSummary: o.descriptionSummary, providerAgentId: o.providerAgentId,
        paymentTokenSymbol: o.paymentTokenSymbol, paymentTokenAmount: o.paymentTokenAmount, attachments: o.file, serviceId: o.serviceId,
        serviceParams: o.serviceParams, serviceTokenAddress: o.serviceTokenAddress, serviceTokenAmount: o.serviceTokenAmount, categoryCode: o.categoryCode,
        minCreditScore, visibility: o.visibility, chainId: o.chainId, serviceGuide: o.serviceGuide, serviceGuideHash: o.serviceGuideHash,
        guideConsentJson: o.guideConsentJson,
      });
    },
  },
  'agent create-subscribe': {
    uses: ['serviceId', 'useTrial', 'serviceParams', 'serviceTokenAmount', 'serviceTokenAddress', 'autoRenew', 'title', 'description', 'file',
      'providerAgentId', 'serviceGuide', 'serviceGuideHash', 'guideConsentJson', 'serviceInterval', 'format'],
    async run(ctx, o) {
      const useTrial = typed(ctx.path, 'useTrial', o.useTrial, 'bool');   // clap BoolishValueParser (spec type "boolish")
      const client = new TaskApiClient();
      const autoRenew = parseBoolOrInt(o.autoRenew, 'auto-renew');
      return handleCreateSubscribe(client, {
        serviceId: o.serviceId, useTrial, serviceParams: o.serviceParams, serviceTokenAmount: o.serviceTokenAmount, serviceTokenAddress: o.serviceTokenAddress, autoRenew,
        title: o.title, description: o.description, attachments: o.file, providerAgentId: o.providerAgentId, serviceGuide: o.serviceGuide,
        serviceGuideHash: o.serviceGuideHash, guideConsentJson: o.guideConsentJson, serviceInterval: o.serviceInterval,
        format: o.format,
      });
    },
  },
  'agent service-detail': {
    uses: ['sid', 'agenticId'],
    async run(ctx, o) {
      return handleServiceDetail(new TaskApiClient(), o.sid, o.agenticId);
    },
  },
  'agent task-create-prepare': {
    uses: ['sid'],
    async run(ctx, o) {
      return handleTaskCreatePrepare(new TaskApiClient(), o.sid);
    },
  },
  'agent service-param-update': {
    uses: ['jobId', 'agentId', 'taskType', 'requestId', 'round', 'serviceParams'],
    async run(ctx, o) {
      const round = typed(ctx.path, 'round', o.round, 'u8');   // value_parser!(u8).range(1..=3), enforced by the parser
      return handleServiceParamUpdate(new TaskApiClient(), o.jobId, o.agentId, o.taskType, o.requestId, round, o.serviceParams);
    },
  },
  'agent mark-failed': {
    uses: ['jobId', 'provider'],
    async run(ctx, o) {
      io(() => markFailed(o.jobId, o.provider));
      return NO_OUTPUT;
    },
  },
  'agent device-list': {
    uses: ['page', 'pageSize'],
    async run(ctx, o) {
      // i64: number when JS-safe, else BigInt (every digit reaches the query / echo)
      const page = typed(ctx.path, 'page', o.page, 'i64');
      const pageSize = typed(ctx.path, 'pageSize', o.pageSize, 'i64');
      return handleDeviceList(new TaskApiClient(), page, pageSize);
    },
  },
  'agent subscribe-device-update': {
    uses: ['jobId', 'deviceList', 'items'],
    async run(ctx, o) {
      return handleSubscribeDeviceUpdate(new TaskApiClient(), o.jobId, o.deviceList, o.items);
    },
  },
  'agent subscribe-offline-update': {
    uses: ['jobId', 'flag'],
    async run(ctx, o) {
      return handleSubscribeOfflineUpdate(new TaskApiClient(), o.jobId, o.flag);
    },
  },
  'agent subscription-execution-config-set': {
    uses: ['serviceId', 'executionMode', 'replace'],
    async run(ctx, o) {
      return handleSubscriptionExecutionConfigSet(o.serviceId, o.executionMode, !!o.replace);
    },
  },
  'agent set-payment-mode': {
    uses: ['jobId', 'paymentMode', 'tokenSymbol', 'tokenAmount'],
    async run(ctx, o) {
      await handleSetPaymentMode(new TaskApiClient(), o.jobId, o.paymentMode, o.tokenSymbol, o.tokenAmount);
      return NO_OUTPUT;
    },
  },
  'agent confirm-accept': {
    uses: ['jobId'],
    async run(ctx, o) {
      await handleConfirmAccept(new TaskApiClient(), o.jobId, undefined);
      return NO_OUTPUT;
    },
  },
  'agent reject-apply': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await handleRejectApply(new TaskApiClient(), o.jobId, o.agentId);
      return NO_OUTPUT;
    },
  },
  'agent reject': {
    uses: ['jobId'],
    ignores: ['reason'],
    async run(ctx, o) {
      throw new Error(`direct reject is disabled by Refund; run \`onchainos agent refund-prepare ${o.jobId} --reason <user-authored-reason>\` and execute only the returned confirmed action`);
    },
  },
  'agent task-visibility-update': {
    uses: ['jobId', 'visibility'],
    async run(ctx, o) {
      return handleTaskVisibilityUpdate(new TaskApiClient(), o.jobId, o.visibility);
    },
  },
  'agent my-tasks': {
    uses: ['taskType', 'statusType', 'page', 'pageSize'],
    async run(ctx, o) {
      // clap ranges (0..=2 / 1.. / 1..=100) are enforced by the parser from lib/spec.json
      const statusType = typed(ctx.path, 'statusType', o.statusType, 'u8');
      const page = typed(ctx.path, 'page', o.page, 'u32');
      const pageSize = typed(ctx.path, 'pageSize', o.pageSize, 'u32');
      return handleMyTasks(new TaskApiClient(), o.taskType, statusType, page, pageSize);
    },
  },
  'agent payment': {
    uses: ['jobId', 'agentId'],
    async run(ctx, o) {
      await handlePayment(new TaskApiClient(), o.jobId, o.agentId ?? '');
      return NO_OUTPUT;
    },
  },
  'agent task-attach': {
    uses: ['jobId', 'file'],
    async run(ctx, o) {
      const client = new TaskApiClient();
      const files = o.file ?? [];
      if (!files.length) throw new Error('at least one --file <path> is required');
      for (const fp of files) await handleTaskAttach(client, o.jobId, fp);
      return NO_OUTPUT;
    },
  },
  'agent list-attachments': {
    uses: ['jobId'],
    async run(ctx, o) {
      handleTaskAttachments(o.jobId);
      return NO_OUTPUT;
    },
  },
};
