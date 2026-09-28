// `ocl doctor` (lite-only): everything needed to run in a sandbox such as the Muse VM,
// without printing secrets.
import tls from 'node:tls';
import { existsSync } from 'node:fs';
import { struct } from '../../core/json.mjs';
import { caList, activeTransport, hasCurl, connectTls } from '../../core/transport.mjs';
import { ApiClient, baseUrl } from '../../core/http.mjs';
import { HOME_DIR, EGRESS_HOSTS, LITE_VERSION, UPSTREAM_VERSION, TRANSPORT } from '../../config.mjs';
import { homePath } from '../../core/home.mjs';
import { getOpt } from '../../core/keyring.mjs';
import { isJwtExpired } from '../../core/http.mjs';
import { load } from '../../core/store.mjs';

const PROBE = '/priapi/v5/wallet/agentic/chain/support/list';   // public, read-only

export default {
  doctor: {
    uses: ['offline'],
    label: 'doctor',
    async run(ctx, o) {
      const systemCa = typeof tls.getCACertificates === 'function' ? 'node:tls system store' : 'bundle files (SSL_CERT_FILE / distro paths)';
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      let reach = null, hosts = null;
      if (!o.offline) {
        // TLS handshake to every host (through the proxy when set) with a long timeout, so a
        // sandbox that asks the user to approve new domains (Muse) raises all prompts now.
        hosts = await Promise.all(EGRESS_HOSTS.map(async (h) => {
          const t = Date.now();
          try {
            const s = await connectTls(`https://${h}`, { timeoutMs: 120000 });
            s.destroy();
            return struct({ host: h, ok: true, ms: Date.now() - t });
          } catch (e) {
            return struct({ host: h, ok: false, ms: Date.now() - t, error: e.message });
          }
        }));
        const t = Date.now();
        try {
          const d = await new ApiClient().post(PROBE, {});
          reach = struct({ ok: true, ms: Date.now() - t, transport: activeTransport(), chains: Array.isArray(d) ? d.length : null });
        } catch (e) {
          reach = struct({ ok: false, ms: Date.now() - t, transport: activeTransport(), error: e.message });
        }
      }
      const access = getOpt('access_token');
      const refresh = getOpt('refresh_token');
      let wallets = null;
      try { wallets = load('wallets.json'); } catch {}
      return struct({
        lite: LITE_VERSION,
        upstreamParity: UPSTREAM_VERSION,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        stateDir: HOME_DIR,
        apiOrigin: baseUrl(),
        egressHosts: EGRESS_HOSTS,
        tls: struct({ trustedCerts: caList().length, systemStore: systemCa, extraCaFile: process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE || null }),
        transport: struct({ mode: TRANSPORT, curlAvailable: hasCurl(), httpsProxy: proxy ? new URL(proxy.includes('://') ? proxy : 'http://' + proxy).host : null, proxyAuth: proxy ? /\/\/[^/@]+@/.test(proxy) : false, nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY ?? null }),
        hostChecks: hosts ?? undefined,
        reachability: reach ?? undefined,
        login: struct({
          loggedIn: !!access && !!wallets,
          accessTokenValid: access ? !isJwtExpired(access) : false,
          refreshTokenValid: refresh ? !isJwtExpired(refresh) : false,
          accounts: Array.isArray(wallets?.accounts) ? wallets.accounts.length : 0,
          keyringFile: existsSync(homePath('keyring.enc')),
        }),
      });
    },
  },
};
