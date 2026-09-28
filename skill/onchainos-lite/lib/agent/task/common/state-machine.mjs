// Task-system state machine — upstream task/common/state_machine.rs (single source of truth
// for event / status strings).
//
// Representation: every Rust enum value is its `as_str()` string. `Status::Other(s)` /
// `Event::Other(s)` are the raw string (never collides with a known variant because parse maps
// known names first); use `Status.isOther` / `Event.isOther` for `matches!(x, Other(_))`.
// `SubStatus` values are their capitalised `as_str()` names ("Active", …).

// ─── Role ───────────────────────────────────────────────────────────
export const Role = Object.freeze({
  User: 'user', Asp: 'asp', Evaluator: 'evaluator',
  // upstream: state_machine.rs::Role::parse → role | undefined
  parse: (s) => (s === 'user' || s === 'asp' || s === 'evaluator' ? s : undefined),
});

// ─── Status ─────────────────────────────────────────────────────────
const STATUS_BY_INT = new Map([[-1, 'init'], [0, 'created'], [1, 'accepted'], [2, 'submitted'], [3, 'rejected'], [4, 'disputed'],
  [5, 'admin_stopped'], [6, 'completed'], [7, 'close'], [8, 'expired'], [9, 'failed']]);
const STATUS_KNOWN = new Set(STATUS_BY_INT.values());
const STATUS_PARSE = new Map([['init', 'init'], ['created', 'created'], ['accepted', 'accepted'], ['submitted', 'submitted'],
  ['rejected', 'rejected'], ['disputed', 'disputed'], ['admin_stopped', 'admin_stopped'], ['adminstopped', 'admin_stopped'],
  ['completed', 'completed'], ['complete', 'completed'], ['close', 'close'], ['closed', 'close'], ['expired', 'expired'], ['failed', 'failed']]);
export const Status = Object.freeze({
  Init: 'init', Created: 'created', Accepted: 'accepted', Submitted: 'submitted', Rejected: 'rejected', Disputed: 'disputed',
  AdminStopped: 'admin_stopped', Completed: 'completed', Close: 'close', Expired: 'expired', Failed: 'failed',
  // upstream: Status::parse
  parse: (s) => STATUS_PARSE.get(s) ?? String(s),
  // upstream: Status::as_str
  asStr: (st) => st,
  // upstream: Status::from_int (i32)
  fromInt: (n) => STATUS_BY_INT.get(Number(n)) ?? `status_${n}`,
  // upstream: Status::is_terminal
  isTerminal: (st) => st === 'completed' || st === 'close' || st === 'expired' || st === 'failed',
  // matches!(st, Status::Other(_))
  isOther: (st) => !STATUS_KNOWN.has(st),
  Other: (s) => String(s),
});

// ─── DisputeRoundStatus ─────────────────────────────────────────────
const ROUND = [['init', 'Evaluation round initializing', 'The evaluation round is being initialized.'],
  ['commit_phase', 'Vote commitment in progress', 'Selected evaluators are submitting encrypted votes.'],
  ['reveal_phase', 'Vote reveal in progress', 'Evaluators are revealing their previously committed votes.'],
  ['completed', 'Evaluation round completed', 'This evaluation round has completed.'],
  ['rejected', 'Evaluation round rejected', 'This evaluation round was rejected.'],
  ['invalidated', 'Evaluation round invalidated', 'This round produced no valid result and awaits the next round.']];
const ROUND_OTHER = ['unknown', 'Round status unavailable', 'The evaluation round status is currently unavailable.'];
// Values are the i32 code; Other(n) keeps n.
export const DisputeRoundStatus = Object.freeze({
  Init: 0, CommitPhase: 1, RevealPhase: 2, Completed: 3, Rejected: 4, Invalidated: 5,
  fromInt: (n) => Number(n),
  asStr: (r) => (ROUND[r] ?? ROUND_OTHER)[0],
  displayLabel: (r) => (ROUND[r] ?? ROUND_OTHER)[1],
  displayDescription: (r) => (ROUND[r] ?? ROUND_OTHER)[2],
  isOther: (r) => !(r >= 0 && r <= 5),
});

// ─── Event ──────────────────────────────────────────────────────────
export const EVENT_NAMES = Object.freeze(['job_created', 'provider_applied', 'job_provider_reject', 'job_user_reject', 'job_asp_selected',
  'job_accepted', 'job_submitted', 'job_completed', 'job_rejected', 'dispute_approved', 'job_disputed', 'job_refunded', 'dispute_resolved',
  'job_expired', 'job_asp_accept_expire', 'job_asp_reject_closed', 'job_asp_reject_expire', 'job_closed', 'job_payment_mode_changed',
  'evaluator_selected', 'reveal_started', 'vote_committed', 'vote_revealed', 'round_failed', 'vote_commit_deadline_warn',
  'vote_reveal_deadline_warn', 'staked', 'unstake_requested', 'unstake_claimed', 'unstake_cancelled', 'reward_claimed', 'submit_expired',
  'reject_expired', 'review_expired', 'job_auto_refunded', 'submit_deadline_warn', 'review_deadline_warn', 'stake_stopped',
  'cooldown_entered', 'attachment_added', 'user_attachment_received', 'deliverable_received', 'negotiate_reply', 'wakeup_notify',
  'sub_open', 'sub_created', 'sub_asp_selected', 'sub_cancel', 'sub_user_reject', 'sub_asp_agree', 'sub_asp_dispute',
  'sub_trial_into_active', 'sub_renew', 'sub_expire_warn', 'sub_complete_notify', 'sub_close_notify', 'sub_failed_notify',
  'sub_reject_refund_notify', 'sub_asp_claim_notify']);
const EVENT_KNOWN = new Set(EVENT_NAMES);
const FAILURE_LABEL = new Map([['job_auto_refunded', 'auto-refund failed'], ['job_closed', 'close failed'],
  ['job_payment_mode_changed', 'payment mode switch failed'], ['reward_claimed', 'reward claim failed'],
  ['dispute_approved', 'evaluation request failed'], ['job_provider_reject', 'asp reject failed'], ['staked', 'staking failed'],
  ['unstake_requested', 'unstake failed'], ['unstake_claimed', 'unstake claim failed'], ['unstake_cancelled', 'unstake cancellation failed'],
  ['stake_stopped', 'stop staking failed'], ['cooldown_entered', 'cooldown entry failed'], ['sub_cancel', 'cancel subscription failed'],
  ['sub_user_reject', 'reject subscription delivery failed']]);
export const Event = Object.freeze({
  // upstream: Event::parse — known names map to themselves, anything else is Other(s).
  parse: (s) => String(s),
  asStr: (e) => e,
  isOther: (e) => !EVENT_KNOWN.has(e),
  // upstream: Event::failure_label
  failureLabel: (e) => FAILURE_LABEL.get(e) ?? 'transaction failed',
});

// ─── Bidirectional mapping ──────────────────────────────────────────
const WHEN = new Map();
const put = (status, evs) => { for (const e of evs) WHEN.set(e, status); };
put('created', ['job_created', 'provider_applied', 'job_asp_selected', 'job_provider_reject', 'job_user_reject', 'negotiate_reply', 'job_payment_mode_changed']);
put('accepted', ['job_accepted', 'deliverable_received', 'submit_deadline_warn']);
put('submitted', ['job_submitted', 'review_expired', 'review_deadline_warn']);
put('rejected', ['job_rejected', 'reject_expired', 'dispute_approved']);
put('expired', ['submit_expired', 'job_expired', 'job_asp_accept_expire']);
put('disputed', ['job_disputed', 'evaluator_selected', 'vote_committed', 'reveal_started', 'vote_revealed', 'cooldown_entered',
  'round_failed', 'vote_commit_deadline_warn', 'vote_reveal_deadline_warn']);
put('completed', ['job_completed', 'dispute_resolved']);
put('failed', ['job_refunded', 'job_auto_refunded', 'job_asp_reject_expire']);
put('close', ['job_closed', 'job_asp_reject_closed']);
put('staking', ['staked', 'unstake_requested', 'unstake_claimed', 'unstake_cancelled', 'stake_stopped']);
put('reward_claimed', ['reward_claimed']);
put('attachment', ['attachment_added', 'user_attachment_received']);
put('wakeup', ['wakeup_notify']);
put('subscription', ['sub_open', 'sub_created', 'sub_asp_selected', 'sub_cancel', 'sub_user_reject', 'sub_asp_agree', 'sub_asp_dispute',
  'sub_trial_into_active', 'sub_renew', 'sub_expire_warn', 'sub_complete_notify', 'sub_close_notify', 'sub_failed_notify', 'sub_reject_refund_notify']);
put('notification', ['sub_asp_claim_notify']);

// upstream: state_machine.rs::status_when_event → Status (Other("unknown") for unrecognised events)
export const statusWhenEvent = (e) => WHEN.get(e) ?? 'unknown';

const ENTRY = new Map([['created', 'job_created'], ['accepted', 'job_accepted'], ['submitted', 'job_submitted'], ['rejected', 'job_rejected'],
  ['disputed', 'job_disputed'], ['completed', 'job_completed'], ['close', 'job_closed'], ['expired', 'job_expired'], ['failed', 'job_refunded']]);
// upstream: state_machine.rs::entry_event → Event | undefined
export const entryEvent = (s) => ENTRY.get(s);

// upstream: state_machine.rs::parse_status_or_event
export function parseStatusOrEvent(s) {
  const evt = Event.parse(s);
  if (!Event.isOther(evt)) return evt;
  return entryEvent(Status.parse(s)) ?? String(s);
}

// ─── SubStatus ──────────────────────────────────────────────────────
const SUB_BY_CODE = new Map([[-1, 'Init'], [0, 'Created'], [1, 'Active'], [3, 'Rejected'], [4, 'Disputed'], [6, 'Completed'], [7, 'Closed'], [8, 'Expired'], [9, 'Failed']]);
const SUB_CODE = new Map([...SUB_BY_CODE].map(([c, n]) => [n, c]));
const SUB_TARGETS = { Init: ['Created'], Created: ['Active', 'Closed', 'Expired'], Active: ['Active', 'Rejected', 'Completed', 'Closed'],
  Rejected: ['Failed', 'Disputed'], Disputed: ['Completed', 'Failed'], Completed: [], Failed: [], Closed: [], Expired: [] };
export const SubStatus = Object.freeze({
  Init: 'Init', Created: 'Created', Active: 'Active', Rejected: 'Rejected', Disputed: 'Disputed', Completed: 'Completed',
  Closed: 'Closed', Expired: 'Expired', Failed: 'Failed',
  // upstream: SubStatus::from_code (unknown → Init)
  fromCode: (code) => SUB_BY_CODE.get(Number(code)) ?? 'Init',
  code: (s) => SUB_CODE.get(s),
  asStr: (s) => s,
  isTerminal: (s) => s === 'Completed' || s === 'Failed' || s === 'Closed' || s === 'Expired',
  validTargets: (s) => SUB_TARGETS[s] ?? [],
  canTransitionTo: (s, target) => (SUB_TARGETS[s] ?? []).includes(target),
});

const SUB_AFTER = new Map([['sub_open', 'Created'], ['sub_created', 'Active'], ['sub_asp_selected', 'Active'], ['sub_trial_into_active', 'Active'],
  ['sub_user_reject', 'Rejected'], ['sub_asp_agree', 'Failed'], ['sub_asp_dispute', 'Disputed'], ['sub_complete_notify', 'Completed'],
  ['sub_close_notify', 'Closed'], ['sub_failed_notify', 'Failed'], ['sub_reject_refund_notify', 'Failed']]);
// upstream: state_machine.rs::sub_status_after_event → SubStatus | undefined
export const subStatusAfterEvent = (e) => SUB_AFTER.get(e);

// upstream: state_machine.rs::parse_sub_status
export function parseSubStatus(s) {
  const str = String(s);
  if (/^[+-]?[0-9]+$/.test(str)) {
    const b = BigInt(str);
    if (b >= -9223372036854775808n && b <= 9223372036854775807n) return SubStatus.fromCode(Number(b));
  }
  const byName = { init: 'Init', created: 'Created', active: 'Active', rejected: 'Rejected', disputed: 'Disputed', completed: 'Completed',
    failed: 'Failed', closed: 'Closed', expired: 'Expired' }[str.replace(/[A-Z]/g, (c) => c.toLowerCase())];
  return byName ?? 'Init';
}
