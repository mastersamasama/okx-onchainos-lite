// Parity proxy. Both CLIs talk to this local origin instead of the real API.
//   record: requests from the upstream CLI are forwarded to the real API when the
//           safety policy allows it (read-only), otherwise answered from fixtures.
//           Every exchange is appended to the cassette.
//   replay: requests from lite are matched against the cassette and answered with
//           the recorded response; unmatched requests get a 599 and are reported.
// Safety: state-changing and fund-moving endpoints are NEVER forwarded.
import http from 'node:http';
import { request as transportRequest } from '../../skill/onchainos-lite/lib/core/transport.mjs';
import { canonicalRequest, matchScore } from './canon.mjs';
import { attachWs } from './ws-proxy.mjs';

const REAL_BASE = process.env.PARITY_REAL_BASE || 'https://web3.okx.com';
const REDACT = new Set(['authorization', 'ok-access-sign', 'ok-access-key', 'ok-access-passphrase', 'cookie']);

export function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = REDACT.has(k.toLowerCase()) ? `<redacted:${String(v).length}>` : v;
  return out;
}

// policy: (req) => 'forward' | 'fixture' | 'block'
// ws: WebSocket options for ws-proxy.mjs ({ network, fixture }) — upgrades on the same port.
export function createProxy({ port = 18899, mode, cassette, policy, fixtures, ws: wsOpts }) {
  const log = [];            // every request seen this run (canonical)
  const used = new Set();    // cassette indexes consumed in replay
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const entry = canonicalRequest({ method: req.method, url: req.url, headers: req.headers, body });
    log.push(entry);
    try {
      if (mode === 'record') {
        const decision = policy(entry);
        let response;
        if (decision === 'forward') {
          const headers = { ...req.headers };
          delete headers.host; delete headers['content-length']; delete headers.connection;
          const r = await transportRequest({ method: req.method, url: REAL_BASE + req.url, headers, body: body.length ? body : undefined, timeoutMs: 60000 });
          response = { status: r.status, headers: pickHeaders(r.headers), body: r.body.toString('utf8'), source: 'real' };
        } else {
          const f = fixtures?.(entry);
          response = f
            ? { status: f.status ?? 200, headers: f.headers ?? { 'content-type': 'application/json' }, body: typeof f.body === 'string' ? f.body : JSON.stringify(f.body), source: 'fixture' }
            : { status: 599, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '599', msg: `parity proxy: ${decision} ${entry.method} ${entry.path} (no fixture)`, data: [] }), source: decision };
        }
        cassette.exchanges.push({ request: { ...entry, headers: redactHeaders(entry.headers) }, response });
        return reply(res, response);
      }
      // replay
      let best = -1, bestScore = -1;
      cassette.exchanges.forEach((x, i) => {
        if (used.has(i)) return;
        const s = matchScore(x.request, entry);
        if (s > bestScore) { best = i; bestScore = s; }
      });
      if (best >= 0 && bestScore >= 100) {
        used.add(best);
        entry.matched = best;
        return reply(res, cassette.exchanges[best].response);
      }
      entry.unmatched = true;
      return reply(res, { status: 599, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '599', msg: `parity proxy: no recorded exchange for ${entry.method} ${entry.path}`, data: [] }) });
    } catch (e) {
      entry.error = e.message;
      const response = { status: 598, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '598', msg: `parity proxy error: ${e.message}`, data: [] }), source: 'proxy-error' };
      // record the failed forward too, so the replay sees the same exchange sequence
      if (mode === 'record') cassette.exchanges.push({ request: { ...entry, headers: redactHeaders(entry.headers) }, response });
      reply(res, response);
    }
  });
  const ws = attachWs(server, { mode, cassette, ...(wsOpts || {}) });
  return {
    log, used, ws,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }),
    close: () => new Promise((r) => { ws.closeAll(); server.closeAllConnections?.(); server.close(r); }),
  };
}

const KEEP = ['content-type', 'ok-web3-openapi-pay', 'payment-required', 'www-authenticate', 'x-payment-response', 'payment-response'];
function pickHeaders(h) {
  const out = {};
  for (const k of KEEP) if (h[k] !== undefined) out[k] = h[k];
  return out;
}

function reply(res, r) {
  res.writeHead(r.status, r.headers);
  res.end(r.body);
}
