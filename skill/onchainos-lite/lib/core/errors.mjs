// Error types that map to upstream main.rs downcast branches and exit codes.
// Plain Error → {"ok":false,"error":"<message chain>"} exit 1 (anyhow `{:#}`: "ctx: cause").

export class CliError extends Error {}

// anyhow .context(): "outer: inner" when printed with {:#}.
export function context(msg, cause) {
  const e = new CliError(cause ? `${msg}: ${cause.message ?? cause}` : msg);
  e.cause = cause;
  return e;
}

export class WalletPreviewConfirming extends Error {   // exit 2
  constructor({ message = '', next = '', scene, preview }) { super(`confirming: ${message}`); Object.assign(this, { msg: message, next, scene, preview }); }
}
export class Confirming extends Error {                // exit 2
  constructor({ message = '', next = '', scene } = {}) { super(`confirming: ${message}`); Object.assign(this, { msg: message, next, scene }); }
}
export class SetupRequired extends Error {             // exit 3
  constructor({ errorCode, message, data }) { super(`setup-required: ${message}`); Object.assign(this, { errorCode, msg: message, data }); }
}
export class BespokeExit extends Error {               // handler already printed; exit with code
  constructor(code) { super(`bespoke exit: ${code}`); this.code = code; }
}
export class FundingBlocked extends Error {            // {ok:false,data} exit 1
  constructor(data) { super('insufficient balance'); this.data = data; }
}
export class DuplicateSubscription extends Error {     // {ok:false,data} exit 1
  constructor(data) { super('duplicate subscription'); this.data = data; }
}
export class CodedError extends Error {                // {ok:false,error,errorCode,...} exit 1
  constructor(code, field, message, { data, nextSteps } = {}) { super(message); Object.assign(this, { code, field, data, nextSteps }); }
}
export class InsufficientBalance extends Error {       // exit 1
  constructor({ message, depositAddress, depositChain, currency, shortfall }) { super(message); Object.assign(this, { depositAddress, depositChain, currency, shortfall }); }
}
// clap-style usage error: printed to stderr, exit 2.
export class UsageError extends Error {
  constructor(message, usage) { super(message); this.usage = usage; }
}
