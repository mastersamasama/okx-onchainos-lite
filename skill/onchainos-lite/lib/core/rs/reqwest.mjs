// reqwest 0.12 error semantics: `reqwest::Error` Display (`e.to_string()`, no source chain) is
// "<kind>" or "<kind> for url (<url>)".
export class ReqwestError extends Error {
  constructor(kind, url, cause) {
    super(kind + (url ? ` for url (${url})` : ''));
    this.kind = kind; this.url = url; this.cause = cause;
  }
}
// Url Display (the WHATWG-serialised href), or the input unchanged when it does not parse.
export const hrefOf = (u) => { try { return new URL(u).href; } catch { return u; } };
