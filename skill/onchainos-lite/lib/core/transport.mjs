// HTTP transport. Two interchangeable backends behind one function:
//   node — node:https with CA = bundled roots + system store + extra bundles
//   curl — the system curl binary (OS trust store), for sandboxes where only curl works
// OCL_TRANSPORT=auto (default) uses node and retries once through curl when the
// TLS chain cannot be verified — e.g. a TLS-inspecting egress proxy whose CA is in
// the system store (Muse Sentinel). HTTPS_PROXY / NO_PROXY are honoured by both.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { TRANSPORT, HTTP_TIMEOUT_MS } from '../config.mjs';

const TRUST_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_UNTRUSTED', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const SYSTEM_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/ca-bundle.pem',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', '/etc/ssl/cert.pem', '/usr/local/etc/openssl/cert.pem',
];

const splitPem = (text) => text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];

let caCache;
export function caList() {
  if (caCache) return caCache;
  const certs = new Set(tls.rootCertificates);
  const add = (pems) => pems.forEach((c) => certs.add(c));
  if (typeof tls.getCACertificates === 'function') {
    try { add(tls.getCACertificates('system')); } catch {}
  }
  const files = [process.env.SSL_CERT_FILE, process.env.NODE_EXTRA_CA_CERTS, process.env.REQUESTS_CA_BUNDLE, process.env.CURL_CA_BUNDLE, ...SYSTEM_BUNDLES];
  for (const f of files) {
    if (f && existsSync(f)) try { add(splitPem(readFileSync(f, 'utf8'))); } catch {}
  }
  for (const dir of (process.env.SSL_CERT_DIR || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    try {
      for (const name of readdirSync(dir)) if (/\.(pem|crt)$/i.test(name)) add(splitPem(readFileSync(join(dir, name), 'utf8')));
    } catch {}
  }
  caCache = [...certs];
  return caCache;
}

function proxyFor(target) {
  const u = new URL(target);
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return null;
  if (noProxy.some((p) => p === '*' || host === p.replace(/^\./, '') || host.endsWith(p.startsWith('.') ? p : '.' + p))) return null;
  const raw = u.protocol === 'https:'
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
    : process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  return raw ? new URL(raw.includes('://') ? raw : 'http://' + raw) : null;
}

// Open a TLS socket to host:port, tunnelling through an HTTP CONNECT proxy when configured.
export function connectTls(targetUrl, { timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const u = new URL(targetUrl);
  const port = Number(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80));
  const proxy = proxyFor(u.href.replace(/^ws/, 'http'));
  const tlsOpts = { host: u.hostname, servername: u.hostname, port, ca: caList(), ALPNProtocols: ['http/1.1'] };
  if (!proxy) return new Promise((resolve, reject) => {
    const s = tls.connect(tlsOpts, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeoutMs, () => s.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })));
  });
  return openTunnel(proxy, u.hostname, port, timeoutMs).then((socket) => new Promise((resolve, reject) => {
    const s = tls.connect({ ...tlsOpts, socket }, () => resolve(s));
    s.once('error', reject);
  }));
}

const proxyAuth = (proxy) => (proxy.username
  ? 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
  : null);
const bare = (h) => h.replace(/^\[|\]$/g, '');

// Raw CONNECT over a plain socket. Deliberately not http.request: runtimes that set
// NODE_USE_ENV_PROXY=1 (e.g. the Muse VM) re-route node:http requests themselves.
export function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(proxy.port || 80), bare(proxy.hostname));
    const fail = (e) => { clearTimeout(timer); sock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(Object.assign(new Error('proxy connect timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    sock.once('error', fail);
    sock.once('connect', () => {
      const auth = proxyAuth(proxy);
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onData);
      const status = Number(buf.toString('latin1', 0, end).split(' ')[1]);
      if (status !== 200) return fail(Object.assign(new Error(`proxy CONNECT to ${host}:${port} failed: HTTP ${status}`), { code: 'EPROXY' }));
      clearTimeout(timer);
      sock.removeListener('error', fail);
      const rest = buf.subarray(end + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.on('data', onData);
  });
}

async function viaNode({ method, url, headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS }) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const opts = { method, headers: { ...headers }, timeout: timeoutMs };
  if (payload) opts.headers['content-length'] = String(payload.length);
  let lib = isHttps ? https : http;
  if (isHttps) {
    const proxy = proxyFor(url);
    if (proxy) {
      // Speak HTTP/1.1 ourselves over the CONNECT tunnel: newer Node releases with
      // NODE_USE_ENV_PROXY=1 (Muse VM) ignore createConnection and dial the proxy directly.
      const socket = await connectTls(url, { timeoutMs });
      return rawRequest(socket, { method, host: u.host, path: u.pathname + u.search, headers: opts.headers, payload, timeoutMs });
    }
    Object.assign(opts, { ca: caList(), agent: false });
  } else {
    const proxy = proxyFor(url);
    if (proxy) {
      const auth = proxyAuth(proxy);
      Object.assign(opts, { host: bare(proxy.hostname), port: proxy.port || 80, path: u.href, agent: false, headers: { ...opts.headers, host: u.host, ...(auth ? { 'proxy-authorization': auth } : {}) } });
      return send(http, opts, payload, timeoutMs);
    }
  }
  return send(lib, { ...opts, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search }, payload, timeoutMs);
}

// Minimal HTTP/1.1 exchange on an already-connected (TLS) socket: one request,
// `Connection: close`, response body via Content-Length, chunked encoding or EOF.
export function rawRequest(socket, { method, host, path, headers, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`];
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'host' && k.toLowerCase() !== 'connection') lines.push(`${k}: ${v}`);
    lines.push('Connection: close');
    const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
    let buf = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => finish(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    function finish(err, res) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(res);
    }
    function tryParse(ended) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return ended ? finish(new Error('connection closed before response headers')) : undefined;
      const [statusLine, ...hl] = buf.toString('latin1', 0, end).split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      if (status === 100) { buf = buf.subarray(end + 4); return tryParse(ended); }
      const h = {};
      for (const l of hl) {
        const i = l.indexOf(':');
        if (i < 0) continue;
        const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
        h[k] = h[k] === undefined ? v : Array.isArray(h[k]) ? [...h[k], v] : k === 'set-cookie' ? [h[k], v] : `${h[k]}, ${v}`;
      }
      const rest = buf.subarray(end + 4);
      if (/chunked/i.test(h['transfer-encoding'] || '')) {
        const out = [];
        let p = 0;
        for (;;) {
          const nl = rest.indexOf('\r\n', p);
          if (nl < 0) return ended ? finish(new Error('truncated chunked body')) : undefined;
          const size = parseInt(rest.toString('latin1', p, nl).split(';')[0], 16);
          if (Number.isNaN(size)) return finish(new Error('invalid chunk size'));
          if (size === 0) return finish(null, { status, headers: h, body: Buffer.concat(out) });
          if (rest.length < nl + 2 + size + 2) return ended ? finish(new Error('truncated chunked body')) : undefined;
          out.push(rest.subarray(nl + 2, nl + 2 + size));
          p = nl + 2 + size + 2;
        }
      }
      if (h['content-length'] !== undefined) {
        const n = Number(h['content-length']);
        if (rest.length >= n) return finish(null, { status, headers: h, body: rest.subarray(0, n) });
        return ended ? finish(new Error('truncated body')) : undefined;
      }
      if (method === 'HEAD' || status === 204 || status === 304) return finish(null, { status, headers: h, body: Buffer.alloc(0) });
      if (ended) return finish(null, { status, headers: h, body: rest });
    }
    socket.on('data', (c) => { buf = Buffer.concat([buf, c]); tryParse(false); });
    socket.on('end', () => tryParse(true));
    socket.on('close', () => tryParse(true));
    socket.on('error', (e) => finish(e));
    socket.write(payload ? Buffer.concat([head, payload]) : head);
  });
}

function send(lib, opts, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    if (payload) req.write(payload);
    req.end();
  });
}

let curlChecked;
export function hasCurl() {
  if (curlChecked === undefined) {
    try { curlChecked = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0; } catch { curlChecked = false; }
  }
  return curlChecked;
}

async function viaCurl({ method, url, headers = {}, body, timeoutMs = HTTP_TIMEOUT_MS }) {
  const dir = mkdtempSync(join(tmpdir(), 'ocl-'));
  const hdrFile = join(dir, 'h');
  const args = ['-sS', '-X', method, '--max-time', String(Math.ceil(timeoutMs / 1000)), '-D', hdrFile, '-o', '-', '--proto', '=https,http'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (payload) args.push('--data-binary', '@-');
  args.push(url);
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const o = [], e = [];
      p.stdout.on('data', (c) => o.push(c));
      p.stderr.on('data', (c) => e.push(c));
      p.on('error', reject);
      p.on('close', (code) => code === 0 ? resolve(Buffer.concat(o)) : reject(Object.assign(new Error(`curl failed (${code}): ${Buffer.concat(e).toString().trim()}`), { code: 'ECURL' })));
      if (payload) p.stdin.write(payload);
      p.stdin.end();
    });
    const blocks = readFileSync(hdrFile, 'utf8').split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b));
    const last = blocks.at(-1) || '';
    const [statusLine, ...lines] = last.split(/\r?\n/);
    const resHeaders = {};
    for (const l of lines) {
      const i = l.indexOf(':');
      if (i > 0) {
        const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
        resHeaders[k] = resHeaders[k] ? `${resHeaders[k]}, ${v}` : v;
      }
    }
    return { status: Number(statusLine.split(' ')[1]), headers: resHeaders, body: out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let preferCurl = TRANSPORT === 'curl';
export async function request(req) {
  if (preferCurl) return viaCurl(req);
  try {
    return await viaNode(req);
  } catch (e) {
    if (TRANSPORT === 'auto' && (TRUST_ERRORS.has(e.code) || e.code === 'EPROTO' || /^ERR_SSL_/.test(e.code || '')) && hasCurl()) {
      preferCurl = true;
      return viaCurl(req);
    }
    throw e;
  }
}

export const activeTransport = () => (preferCurl ? 'curl' : 'node');
