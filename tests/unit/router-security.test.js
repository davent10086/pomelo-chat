const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const clientRequire = createRequire(path.resolve(__dirname, '../../client/package.json'));
const { resolvePath } = clientRequire('react-router-dom');

test('router normalizes mixed leading slashes without producing an external URL', () => {
  const backslash = String.fromCharCode(92);
  const origin = 'https://pomelo.invalid';
  for (const prefix of ['//', backslash + backslash, '/' + backslash, backslash + '/']) {
    for (const to of [prefix + 'outside.invalid/chat', { pathname: prefix + 'outside.invalid/chat' }]) {
      const resolved = resolvePath(to, '/login');
      assert.equal(new URL(resolved.pathname, origin).origin, origin, JSON.stringify(to));
      assert.equal(resolved.pathname, '/outside.invalid/chat');
    }
  }
});

test('router preserves ordinary absolute and relative paths, query strings and fragments', () => {
  assert.deepEqual(resolvePath('/chat?room=123#message', '/login'), {
    pathname: '/chat', search: '?room=123', hash: '#message'
  });
  assert.deepEqual(resolvePath('../files', '/chat/thread'), {
    pathname: '/chat/files', search: '', hash: ''
  });
  for (const pathname of ['/login', '/register', '/', '/chat', '/files', '/address-book', '/desktop-assistant']) {
    assert.equal(resolvePath(pathname, '/').pathname, pathname);
  }
});
