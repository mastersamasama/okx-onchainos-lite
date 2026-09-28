// `onchainos agent` identity commands — upstream commands/agent_commerce/identity/mod.rs facade.
// Each command entry returns the `data` value (upstream prints it via output::success; lite's
// dispatcher does the printing). `validateListing` returns the bespoke ValidationResult struct
// that the caller prints pretty, without the envelope.
export { validateListing } from './validate.mjs';
export {
  feedbackList, get, getAgents, getByAddress, getMyAgents, search, serviceList, taskFeedback,
} from './queries.mjs';
export { serviceMatch } from './service-match.mjs';
export {
  activate, create, deactivate, feedbackSubmit, precheck, update, upload, xmtpSign,
} from './mutations.mjs';
