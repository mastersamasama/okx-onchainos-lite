// ASP subscription-completion playbook — upstream task/asp/v2/sub_complete_notify.rs.
import { stringify } from '../../../../core/json.mjs';
import { subCompleteNotifyAspNotify } from '../content.mjs';

// upstream: sub_complete_notify.rs::handle → compact JSON string (sorted keys)
export function handle(jobId, title, periodEnd) {
  return stringify({
    phase: 'subscription_completion', decision: 'ready', reason: 'notification_required',
    nextAction: [{ id: 'notify_and_cleanup_subscription', recommend: true, params: { jobId } }],
    payload: {
      role: 'asp', jobId, notification: { content: subCompleteNotifyAspNotify(title, jobId, periodEnd), localize: true },
      rating: { required: false }, cleanup: { jobId },
    },
  });
}
