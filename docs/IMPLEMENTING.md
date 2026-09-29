# Implementing commands in onchainos-lite

The contract every contributor (human or agent) follows. Read `docs/DESIGN.md` first.
Parity target: upstream onchainos **4.6.3** (`upstream/cli/src`). Behaviour specs extracted
from the Rust source live in `spec/extract/*.md` — use them as the index, and read the Rust
source for any detail the spec leaves unclear. The Rust source always wins.

## 1. Where code goes (mirrors upstream module boundaries)

| Upstream (cli/src/…) | Lite (skill/onchainos-lite/lib/…) | Owner |
|---|---|---|
| main.rs, output.rs, client.rs, endpoints.rs, config.rs, home.rs, audit.rs, device/, chains.rs, payment_cache.rs, payment_notify.rs (state), keyring_store.rs, file_keyring.rs, crypto.rs, clap | `core/*.mjs`, `crypto/*.mjs` (see §2) | core (extend it — never copy it) |
| Rust std / crate semantics: `str`, integer / f64 `FromStr` and `{:.N}`, serde_json::Value accessors, serde_json / serde_derive deserialisation, std::fs / std::path / io::Error Display, chrono, base64 / hex / bs58, serde_jcs, anyhow, process, reqwest Display | `core/serde.mjs`, `core/rs/{str,num,value,fs,time,codec,jcs,anyhow,process,reqwest}.mjs` | core |
| token_alias.rs, validators.rs, commands/sink.rs, funding.rs, qr.rs, commands/common.rs, asset_class.rs, commands/risk_classify.rs | `core/token-alias.mjs`, `core/validators.mjs`, `core/sink.mjs`, `core/funding.mjs`, `core/qr.mjs`, `core/common.mjs`, `core/asset-class.mjs`, `core/risk-classify.mjs` (top-level `cli/src/<x>.rs` → `lib/core/<x>.mjs`) | foundation: core-helpers |
| wallet_api.rs, wallet_store.rs, commands/agentic_wallet/{auth,account,common,chain,chain_profile,shared,…} helpers | `wallet/*.mjs` | foundation: wallet |
| commands/payment/*, payment/permit2, payment/subscription (shared signing) | `payment/*.mjs` | foundation: payment |
| commands/agent_commerce/** shared infrastructure | `agent/**/*.mjs` | foundation: agent |
| commands/ws.rs, watch/ | `core/ws.mjs` (client), `watch/*.mjs` | foundation: ws |
| Every leaf command handler | `commands/<top-level>/<file>.mjs` | command groups |

**Mirror rule (makes every import predictable without coordination):**
- Shared (non-command) upstream code keeps its upstream location and name:
  `cli/src/commands/agentic_wallet/<x>` → `lib/wallet/<x>`, `cli/src/wallet_api.rs` → `lib/wallet/api.mjs`,
  `cli/src/wallet_store.rs` → `lib/wallet/store.mjs`, `cli/src/commands/payment/<x>` and
  `cli/src/payment/<x>` → `lib/payment/<x>`, `cli/src/commands/agent_commerce/<x>` → `lib/agent/<x>`,
  `cli/src/watch/<x>` → `lib/watch/<x>`; file names snake_case → kebab-case `.mjs`
  (`shared/sign_flow.rs` → `lib/wallet/shared/sign-flow.mjs`, a `mod.rs` → `index.mjs`).
- Every exported function mirrors one upstream fn: **camelCase of the Rust name, same parameter
  order, same semantics**, with a `// upstream: <file>.rs::<fn>` comment. Rust structs used as
  JSON get a builder returning `struct({...})` in field order.
- So if you need upstream `agentic_wallet::account::resolve_account_address_for_chain`, you import
  `resolveAccountAddressForChain` from `lib/wallet/account.mjs` — whoever owns that file implements it.

Rules:
- Need something from a module you don't own? Import what exists. If a shared helper is
  missing or incomplete, extend the one module that owns the concern (§2) — never write a
  private copy next to your code.
- Never hard-code a URL, header name, version or chain constant — import it from
  `lib/config.mjs` / `core/chains.mjs` / the owning module. One definition per fact.
- Where JS built-ins differ from Rust at the edges (`trim`, number parsing, `{:?}`, io::Error
  texts, RFC 3339 parsing, strict base64 …) import the Rust behaviour from `lib/core/rs/*.mjs`;
  never re-implement it locally.
- Zero dependencies: Node.js ≥ 18 built-ins only.

## 2. Shared modules

**Rule: never write a private copy of a helper; extend the core module.** Each Rust concern has
exactly one implementation in `lib/core` (byte primitives in `lib/crypto`). A `_`-prefixed file
is only for splitting one module (import cycles, a group's own constants), never for a copy of
something below. There are no `_clap.mjs` workarounds: `core/cli.mjs` enforces clap semantics.

| Rust concern | Module | Owns |
|---|---|---|
| main.rs | `core/main.mjs` | parse → dispatch → print → exit code; audit call; handler loading |
| clap (derive, value parsers) | `core/cli.mjs` | spec-driven parser with clap's accept/reject order and messages; typed parsers `parseClapInt`, `parseRangedInt`, `parseBoolish`, `parseRustF64`, `typed()` |
| commands::Context, config::AppConfig | `core/context.mjs` | per-invocation `ctx` (global `--chain`, clients, config); `EMPTY`, `NO_OUTPUT` |
| output.rs | `core/output.mjs` | every stdout envelope |
| main.rs downcasts, anyhow `.context` | `core/errors.mjs` | error classes → exit codes; `context()` |
| client.rs::ApiClient | `core/http.mjs` | OKX API client: headers, envelope, JWT refresh, x402; `cloneClient` (upstream `client.clone()`); `handleAgentCommerceResponse` |
| reqwest / hyper transport | `core/transport.mjs` | HTTPS via node or curl, CA set, proxy CONNECT, `connectTls` |
| client.rs PaymentState, payment_cache.rs, payment_notify.rs | `core/paystate.mjs`, `core/notify.mjs` | x402 charging state, `payment_cache.json`, notification queue |
| — (lite extension) | `core/apikey.mjs` | API-key (HMAC) auth |
| home.rs | `core/home.mjs` | state dir, atomic / secure writes, `taskStateDir` (PathBuf::join), `ensureDir0700` |
| wallet_store.rs file format | `core/store.mjs` | pretty-JSON state files, `session.json`, chain cache |
| keyring_store.rs, file_keyring.rs | `core/keyring.mjs` | encrypted file keyring, `keyring.lock` |
| chains.rs | `core/chains.mjs` | chain registry and constants, `resolveChain` / `resolveChains` (Rust trim) |
| audit.rs | `core/audit.mjs` | `audit.jsonl` |
| device/ | `core/device.mjs` | device-id / device-name headers |
| crypto.rs | `core/crypto.mjs` | HPKE session key, ed25519 / secp256k1 / EIP-3009 signing (primitives: `crypto/{keccak,secp256k1,curve25519,hpke,eip712,encoding}.mjs`) |
| self-spawn, `open::that_detached` | `core/proc.mjs` | `runSelf`, `spawnSelfDetached`, `openUrl`, `which`, `sleep` |
| tokio-tungstenite | `core/ws.mjs` | WebSocket client with tungstenite limits and error texts |
| serde_json + serde_derive (read) | `core/serde.mjs` | typed `fromStr` / `fromSlice` / `fromValue`: serde's errors, positions, duplicate / missing fields |
| serde_json (write), Value model | `core/json.mjs` | lossless `parse`; `stringify` (sorted Values, `struct()`, `f64()`) |
| token_alias.rs, validators.rs, sink.rs, funding.rs, qr.rs, common.rs, asset_class.rs, risk_classify.rs | `core/<x>.mjs` (kebab-case) | see §1 |
| `str` / `char` | `core/rs/str.mjs` | Unicode-whitespace trim, ASCII case, UTF-8 length / byte order, `{:?}` |
| integers, f64 | `core/rs/num.mjs` | `FromStr`, U256, `as` casts, saturating ops, `{:.N}` |
| serde_json::Value accessors | `core/rs/value.mjs` | `as_*`, `get`, IndexMut (`setIndex`) |
| std::fs / std::path / io::Error | `core/rs/fs.mjs` | io::Error Display (`ioErrorText`), strict UTF-8 reads, `create_new`, Path rules, `pathJoin` |
| SystemTime, chrono, tokio timeouts | `core/rs/time.mjs` | clocks, chrono formatting, RFC 3339 parsing, `timeoutAt` |
| base64 / hex / bs58 | `core/rs/codec.mjs` | strict decoding with the crates' error texts |
| serde_jcs | `core/rs/jcs.mjs` | canonical JSON |
| anyhow | `core/rs/anyhow.mjs` | `downcast`, `outermost` (`{}` vs `{:#}`) |
| std::process | `core/rs/process.mjs` | spawn-failure and ExitStatus Display |
| reqwest::Error | `core/rs/reqwest.mjs` | `ReqwestError` Display |

Leftover private modules (fold into core when touched): `payment/_payment-cache.mjs` (strict
reader; `core/paystate.mjs` keeps the lenient one), `payment/_mcp-client.mjs` (mirror of `mcp_client.rs`),
`payment/_http.mjs` (reqwest client stand-in) and `wallet/utxo/_panic.mjs`.

## 3. Handler contract

```js
// lib/commands/market/price.mjs
export default {
  'market price': {
    uses: ['address', 'chain'],   // every non-global option of this command (camelCase)
    ignores: [],                  // options upstream accepts but ignores
    label: undefined,             // audit label when it differs from "<top> <sub>"
    parsers: undefined,           // { option: fn } for an upstream `value_parser = <fn>`
    async run(ctx, o) { … return data; },
  },
};
```
- `o` holds parsed options: value options are **strings** exactly as typed (clap `String`),
  flags are booleans, repeatable options are arrays, defaults already applied.
- The parser enforces the upstream clap model at parse time (from `spec/clap-model.json`,
  dumped from the upstream binary, plus `spec/overrides.json`): value types (`u32`, `u64`,
  `f64` … with clap's exact error text), possible values, conflicts, requires,
  required-unless, arg groups, repeatable/delimited values, hyphen values, hidden options,
  global-vs-leaf `--chain` rules. Handlers do not re-check any of that; use
  `typed(ctx.path, 'limit', o.limit, 'u32')` only to convert a validated string to a number.
  An upstream `value_parser = <fn>` (spec type `custom`) is declared in `parsers`; the parser
  calls it while parsing, wraps its error in clap's text and hands its result to `o`.
  Positional args appear under their camelCase name.
- The global `--chain` is read through `ctx.chainOverride`, `ctx.chainIndex()`,
  `ctx.chainIndexOr(def)`, `ctx.resolveChainsOr(explicit, def)` (upstream `Context`).
  `agent …` commands always see `xlayer` (a leaf's own `--chain`, e.g. `agent funding-notice`,
  keeps its value).
- Return value → printed as `{"ok":true,"data":<value>}`. Return `EMPTY` (from
  `core/context.mjs`) for `{"ok":true}`; `NO_OUTPUT` when the handler printed itself
  (streaming, bespoke output).
- Errors: throw `Error(message)` with upstream's exact text. anyhow `.context("x")` wraps
  become `context('x', cause)` → `"x: cause"`. Special results use `core/errors.mjs`:
  `Confirming`, `WalletPreviewConfirming`, `SetupRequired`, `CodedError`, `FundingBlocked`,
  `DuplicateSubscription`, `InsufficientBalance`, `BespokeExit`.
- `node tools/check.mjs --top <top>` must report no problems for your commands.

## 4. JSON byte rules (stdout and request bodies)

- Server responses are parsed losslessly by the client (integers stay exact; decimals become
  `F64` objects that re-serialise as Rust would). Pass them through untouched when upstream does.
- Plain JS objects serialise with **sorted keys** — this is what upstream's `json!` /
  `serde_json::Value` does. Use this for anything built with `json!` or `to_value`.
- Objects that upstream serialises from a **struct** keep field order: wrap with
  `struct({...})` (from `core/json.mjs`) in declaration order; set a field to `undefined` for
  `skip_serializing_if`. Remember: `serde_json::to_value(struct)` produces a Value → sorted.
- Rust `f64` in JSON → `f64(x)`; Rust `format!("{}", f64)` into a string → `displayF64(x)`.
  Integers beyond 2^53 → `BigInt`.
- Request bodies go through the same serializer: `api.post(path, {…})` sends sorted keys like
  upstream's `json!`; wrap with `struct()` only when upstream posts a serialised struct.

## 5. HTTP

```js
const api = await ctx.api();          // ApiClient::new_async (refreshes an expired JWT)
const sync = ctx.apiSync();           // ApiClient::new (no expiry check) — only where upstream uses ctx.client()
await api.get(path, [['chainIndex', ci], ['limit', o.limit]]);   // ordered pairs; '' values dropped
await api.post(path, body);           // envelope unwrapped → data
api.getRaw / postRaw / postNoRetry / getResponse / getBytes / postMultipart
handleAgentCommerceResponse(resp)     // core/http.mjs, for agent-commerce raw responses
```
The client already implements headers, envelope errors (`API error (code=…): …`), JWT
refresh-and-retry and x402 auto-pay. Wallet endpoints use the wallet module's client
(`wallet/api.mjs`), which reuses the same headers.

## 6. State, processes, time

- State dir files: `core/store.mjs` (`load`, `save`, `loadSession`, …) — pretty JSON,
  `<name>.tmp` + rename, exactly as upstream. Keyring: `core/keyring.mjs`.
- Upstream spawning its own binary (`onchainos …`) → `runSelf([...])` / `spawnSelfDetached`
  from `core/proc.mjs`. Opening a browser → `openUrl(url)` (honours `ONCHAINOS_NO_BROWSER`).
- Keep upstream timeouts, poll intervals and retry counts.

## 7. Parity tests (required for every command)

Case files: `test/parity/cases/<group>.json`, one array of cases:
```json
{ "id": "market-kline-basic", "argv": ["market","kline","--address","0x…","--chain","ethereum"],
  "home": "anon", "network": "real", "fixtures": [], "masks": ["stdout.data.*.ts"] }
```
- `network: "real"` forwards read-only endpoints to the real API during recording
  (`test/parity/endpoints.json` classifies endpoints; anything not classified `read` is served
  from fixtures). `network: "fixture"` never touches the network.
- `fixtures`: files in `test/parity/fixtures/` → `[{method, path | pathRegex, match?:{query?,body?}, times?, response:{status, body, headers?}}]`.
  Fixture bodies must look like real server responses (field names from the Rust response structs).
- `home`: template state dir in `test/parity/homes/` (`anon` = empty; the wallet foundation
  provides logged-in homes). Both CLIs get a fresh copy; files they write are compared too.
- `masks`: `stdout.<path>`, `req.<path>` (e.g. `req.body.timestamp`), `home.<file>.<path>`; `*`
  matches any key/index. Mask only genuinely volatile values (live prices, timestamps, nonces).
- `exact: true | ["stdout","stderr"]` also compares raw stdout bytes / stderr text (usage errors,
  number formatting); `osErrorText: "code"` compares `… (os error N)` texts by code only (localized
  Windows, see `docs/PARITY.md`).
- Run: `node test/parity/run.mjs --cases <group>` (records upstream once per case change, then
  replays lite). `--id <case>` for one case; `--mode both` to force re-recording.
  Never write a case that makes upstream move funds: fund/state endpoints are never forwarded,
  and fixture responses stand in for them.
- Cover: every command at least once; each error branch that is reachable offline; flag
  combinations that change the request; output transforms.
- Pure helpers also get unit tests in `test/unit/<area>.test.mjs` (`node tools/test-unit.mjs`).

## 8. Definition of done for a command group

1. `node tools/check.mjs --top <top>` clean for the group's commands.
2. All the group's parity cases pass; every command has ≥ 1 case.
3. Known, intentional divergences are listed in `docs/PARITY.md` with the reason.
