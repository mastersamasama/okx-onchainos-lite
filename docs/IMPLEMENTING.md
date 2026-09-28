# Implementing commands in onchainos-lite

The contract every contributor (human or agent) follows. Read `docs/DESIGN.md` first.
Parity target: upstream onchainos **4.6.3** (`upstream/cli/src`). Behaviour specs extracted
from the Rust source live in `spec/extract/*.md` — use them as the index, and read the Rust
source for any detail the spec leaves unclear. The Rust source always wins.

## 1. Where code goes (mirrors upstream module boundaries)

| Upstream (cli/src/…) | Lite (skill/onchainos-lite/lib/…) | Owner |
|---|---|---|
| main.rs, output.rs, client.rs, endpoints.rs, config.rs, home.rs, audit.rs, device/, chains.rs, payment_cache.rs, payment_notify.rs (state), keyring_store.rs, file_keyring.rs, crypto.rs | `core/*.mjs`, `crypto/*.mjs` | core (done; request changes, do not edit) |
| token_alias.rs, validators.rs, commands/sink.rs, funding.rs, qr.rs, commands/common.rs, asset_class.rs | `core/token-alias.mjs`, `core/validators.mjs`, `core/sink.mjs`, `core/funding.mjs`, `core/qr.mjs`, `core/common.mjs`, `core/asset-class.mjs` (top-level `cli/src/<x>.rs` → `lib/core/<x>.mjs`) | foundation: core-helpers |
| wallet_api.rs, wallet_store.rs, commands/agentic_wallet/{auth,account,common,chain,chain_profile,shared,…} helpers | `wallet/*.mjs` | foundation: wallet |
| commands/payment/*, payment/permit2, payment/subscription (shared signing) | `payment/*.mjs` | foundation: payment |
| commands/agent_commerce/** shared infrastructure | `agent/**/*.mjs` | foundation: agent |
| commands/ws.rs, watch/ | `core/ws.mjs` (client), `ws/*.mjs` | foundation: ws |
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
- Only edit files you own. Need something from a module you don't own? Import what exists;
  if it is missing, write the smallest private helper in your own area (prefix file with `_`)
  and list it under "requests" in your report so it can be promoted.
- Never hard-code a URL, header name, version or chain constant — import it from
  `lib/config.mjs` / `core/chains.mjs` / the owning module. One definition per fact.
- Zero dependencies: Node.js ≥ 18 built-ins only.

## 2. Handler contract

```js
// lib/commands/market/price.mjs
export default {
  'market price': {
    uses: ['address', 'chain'],   // every non-global option of this command (camelCase)
    ignores: [],                  // options upstream accepts but ignores
    label: undefined,             // audit label when it differs from "<top> <sub>"
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
  Positional args appear under their camelCase name.
- The global `--chain` is read through `ctx.chainOverride`, `ctx.chainIndex()`,
  `ctx.chainIndexOr(def)`, `ctx.resolveChainsOr(explicit, def)` (upstream `Context`).
  `agent …` commands always see `xlayer`.
- Return value → printed as `{"ok":true,"data":<value>}`. Return `EMPTY` (from
  `core/context.mjs`) for `{"ok":true}`; `NO_OUTPUT` when the handler printed itself
  (streaming, bespoke output).
- Errors: throw `Error(message)` with upstream's exact text. anyhow `.context("x")` wraps
  become `context('x', cause)` → `"x: cause"`. Special results use `core/errors.mjs`:
  `Confirming`, `WalletPreviewConfirming`, `SetupRequired`, `CodedError`, `FundingBlocked`,
  `DuplicateSubscription`, `InsufficientBalance`, `BespokeExit`.
- `node tools/check.mjs --top <top>` must report no problems for your commands.

## 3. JSON byte rules (stdout and request bodies)

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

## 4. HTTP

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

## 5. State, processes, time

- State dir files: `core/store.mjs` (`load`, `save`, `loadSession`, …) — pretty JSON,
  `<name>.tmp` + rename, exactly as upstream. Keyring: `core/keyring.mjs`.
- Upstream spawning its own binary (`onchainos …`) → `runSelf([...])` / `spawnSelfDetached`
  from `core/proc.mjs`. Opening a browser → `openUrl(url)` (honours `ONCHAINOS_NO_BROWSER`).
- Keep upstream timeouts, poll intervals and retry counts.

## 6. Parity tests (required for every command)

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
- Run: `node test/parity/run.mjs --cases <group>` (records upstream once per case change, then
  replays lite). `--id <case>` for one case; `--mode both` to force re-recording.
  Never write a case that makes upstream move funds: fund/state endpoints are never forwarded,
  and fixture responses stand in for them.
- Cover: every command at least once; each error branch that is reachable offline; flag
  combinations that change the request; output transforms.
- Pure helpers also get unit tests in `test/unit/<area>.test.mjs` (`node --test`).

## 7. Definition of done for a command group

1. `node tools/check.mjs --top <top>` clean for the group's commands.
2. All the group's parity cases pass; every command has ≥ 1 case.
3. Known, intentional divergences are listed in `docs/PARITY.md` with the reason.
