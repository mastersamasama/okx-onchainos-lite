// The single source of every constant in onchainos-lite.
// Nothing else in code or docs repeats these values; `ocl doctor` prints them.
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = (name) => (process.env[name] && process.env[name].trim()) || undefined;

// Upstream release this runtime is parity-locked to. Sent as `ok-client-version`
// exactly like the upstream binary (CARGO_PKG_VERSION), so the server sees an
// identical client.
export const UPSTREAM_VERSION = '4.6.3';
export const LITE_VERSION = '0.1.0';

// Endpoints. Upstream compiles these in from cli/.env; lite reads the same
// defaults and allows env overrides for the parity proxy and development only.
export const DEFAULT_BASE_URL = 'https://web3.okx.com';
export const DEV_BASE_URL = 'https://beta.okex.org';          // hidden --dev
export const BASE_URL = env('OCL_BASE_URL') ?? DEFAULT_BASE_URL;
export const WS_URL = env('OCL_WS_URL') ?? 'wss://wsdex.okx.com/ws/v6/dex';
export const AGENT_WS_URL = env('OCL_AGENT_WS_URL') ?? 'wss://wsdex.okx.com:8443/ws/v5/private';
export const XLAYER_RPC_URL = env('OCL_XLAYER_RPC_URL') ?? 'https://rpc.xlayer.tech';
export const API_HOST = 'web3.okx.com';

// Hosts this runtime may contact (for sandbox egress allow-lists, e.g. Muse Sentinel).
export const EGRESS_HOSTS = [...new Set([BASE_URL, WS_URL, AGENT_WS_URL, XLAYER_RPC_URL].map((u) => new URL(u).hostname))];

// Request identity headers (client.rs::anonymous_headers).
export const CLIENT_TYPE = 'agent-cli';

// State directory. Separate from upstream's ~/.onchainos so both can coexist;
// file names and formats inside are identical to upstream.
// Like upstream onchainos_home(): used verbatim (untrimmed) when set and non-empty.
const raw = (name) => (process.env[name] ? process.env[name] : undefined);
export const HOME_DIR = raw('OCL_HOME') ?? raw('ONCHAINOS_HOME') ?? join(homedir(), '.onchainos-lite');

// Transport: auto (node, curl fallback on TLS trust failure) | node | curl.
export const TRANSPORT = env('OCL_TRANSPORT') ?? 'auto';
export const HTTP_TIMEOUT_MS = Number(env('OCL_HTTP_TIMEOUT_MS') ?? 30000);

// Output: compact by default; ONCHAINOS_PRETTY=1 (upstream name) or OCL_PRETTY=1 pretty-prints.
export const PRETTY = process.env.ONCHAINOS_PRETTY === '1' || process.env.OCL_PRETTY === '1';
