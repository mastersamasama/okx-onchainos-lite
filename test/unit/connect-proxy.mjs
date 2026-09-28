// Minimal authenticated HTTP CONNECT proxy used by transport tests (mimics a sandbox
// egress proxy such as Muse's hatch-egress-proxy:3128 with Basic proxy credentials).
import http from 'node:http';
import net from 'node:net';

export function startConnectProxy({ user = 'u', pass = 'p', port = 0 } = {}) {
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url }); res.writeHead(405); res.end('CONNECT only'); });
  server.on('connect', (req, clientSocket, head) => {
    seen.push({ method: 'CONNECT', url: req.url, auth: req.headers['proxy-authorization'] === expected });
    if (req.headers['proxy-authorization'] !== expected) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
      return;
    }
    const [host, p] = req.url.split(':');
    const upstream = net.connect(Number(p), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://${user}:${pass}@127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
