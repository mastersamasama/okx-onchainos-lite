// Transport through an authenticated CONNECT proxy (the Muse VM egress shape):
// raw CONNECT tunnel + our own HTTP/1.1 exchange, immune to NODE_USE_ENV_PROXY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openTunnel, rawRequest } from '../../skill/onchainos-lite/lib/core/transport.mjs';
import { startConnectProxy } from './connect-proxy.mjs';

function target() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/chunked') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"a":'); res.end('1}'); return; }
      res.writeHead(201, { 'content-type': 'application/json', 'ok-web3-openapi-pay': 'Basic=0' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, auth: req.headers['x-test'] ?? null }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, close: () => new Promise((c) => { server.closeAllConnections?.(); server.close(c); }) })));
}

test('CONNECT tunnel with Basic proxy auth, content-length body', async () => {
  const t = await target();
  const p = await startConnectProxy({ user: 'hatch-runtime', pass: 's3cret' });
  const sock = await openTunnel(new URL(p.url), '127.0.0.1', t.port, 5000);
  const r = await rawRequest(sock, { method: 'POST', host: `127.0.0.1:${t.port}`, path: '/x?y=1', headers: { 'x-test': 'yes', 'content-length': '2' }, payload: Buffer.from('{}'), timeoutMs: 5000 });
  assert.equal(r.status, 201);
  assert.equal(r.headers['ok-web3-openapi-pay'], 'Basic=0');
  assert.deepEqual(JSON.parse(r.body.toString()), { method: 'POST', url: '/x?y=1', body: '{}', auth: 'yes' });
  assert.equal(p.seen[0].auth, true);
  await p.close(); await t.close();
});

test('chunked response body', async () => {
  const t = await target();
  const p = await startConnectProxy();
  const sock = await openTunnel(new URL(p.url), '127.0.0.1', t.port, 5000);
  const r = await rawRequest(sock, { method: 'GET', host: `127.0.0.1:${t.port}`, path: '/chunked', headers: {}, timeoutMs: 5000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), '{"a":1}');
  await p.close(); await t.close();
});

test('wrong proxy credentials surface HTTP 407', async () => {
  const t = await target();
  const p = await startConnectProxy({ user: 'a', pass: 'b' });
  await assert.rejects(openTunnel(new URL(p.url.replace('a:b', 'a:c')), '127.0.0.1', t.port, 5000), /HTTP 407/);
  await p.close(); await t.close();
});
