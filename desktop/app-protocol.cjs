const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const APP_ORIGIN = 'pomelo://app';
const routes = new Set(['/', '/index.html', '/login', '/register', '/chat', '/address-book', '/files', '/desktop-assistant']);
function sameOrigin(value, expected) {
  try {
    const a = new URL(value), b = new URL(expected);
    return a.protocol === b.protocol && a.host === b.host && !a.username && !a.password;
  } catch { return false; }
}
function resolveResource(root, value) {
  const url = new URL(value);
  if (!sameOrigin(value, APP_ORIGIN)) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  const target = path.resolve(root, `.${routes.has(pathname) ? '/index.html' : pathname}`);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}
async function registerAppProtocol(ses, root, net, serverURL) {
  if (await ses.protocol.isProtocolHandled('pomelo')) return;
  const server = serverURL || 'https://localhost';
  const ws = server.replace(/^http/, 'ws');
  const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: ${server}; font-src 'self' data:; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* http://[::1]:* ${server} ${ws}; media-src 'self' blob: https: ${server}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`;
  ses.protocol.handle('pomelo', async request => {
    const target = resolveResource(root, request.url);
    if (!target || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return new Response('Not found', { status: 404 });
    const result = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(result.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers });
  });
}
module.exports = { APP_ORIGIN, sameOrigin, resolveResource, registerAppProtocol };
