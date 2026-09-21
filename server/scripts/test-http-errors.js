require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const http = require('node:http');
const expressWs = require('express-ws');

process.env.POMELO_SKIP_AUTO_DB_INIT = 'true';
const appModule = require('../src/controller/app');
const { better_chat } = require('../src/utils/authenticate');

const request = (server, options, body = '') => new Promise((resolve, reject) => {
  const port = server.address().port;
  const req = http.request({ host: '127.0.0.1', port, ...options }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  req.end(body);
});

const main = async () => {
  const server = http.createServer(appModule.default);
  expressWs(appModule.default, server);
  appModule.registerAppRoutes();
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const unauthorized = await request(server, { method: 'GET', path: '/api/chat/v1/message/chat_list' });
    assert.equal(unauthorized.status, 401);
    assert.equal(JSON.parse(unauthorized.text).code, 1002);

    const malformed = await request(server, {
      method: 'POST',
      path: '/api/chat/v1/auth/login',
      headers: { 'Content-Type': 'application/json' }
    }, '{');
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(malformed.text), { code: 1003, data: '', message: '参数错误' });
    assert.doesNotMatch(malformed.text, /SyntaxError|node_modules|server\\src|server\/src/);

    const missing = await request(server, { method: 'GET', path: '/api/chat/v1/auth/login' });
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.text).code, 1007);
  } finally {
    await new Promise(resolve => server.close(resolve));
    better_chat.disconnect();
  }
};

main().then(() => {
  console.log('[http-errors] API errors are JSON and use semantic HTTP status codes.');
  process.exit(0);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
