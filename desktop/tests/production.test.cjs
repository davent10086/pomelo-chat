const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeServer, createSettings } = require('../settings.cjs');
const { resolveResource, sameOrigin } = require('../app-protocol.cjs');
const { validAuth, trustedFrame } = require('../protocol.cjs');

test('server settings accept HTTPS and loopback only, without credentials or URL components', () => {
  assert.equal(normalizeServer(' https://chat.example.com/ '), 'https://chat.example.com');
  assert.equal(normalizeServer('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const input of ['file:///C:/secret', 'http://example.com', 'https://u:p@example.com', 'https://example.com/api', 'https://example.com/?token=x', 'https://example.com/#x', '', null])
    assert.throws(() => normalizeServer(input));
});
test('custom protocol confines resources and IPC to the exact application host and window role', () => {
  const root = path.resolve('fixture-renderer');
  assert.equal(resolveResource(root, 'pomelo://app/login'), path.join(root, 'index.html'));
  assert.equal(resolveResource(root, 'pomelo://app/assets/worker.js'), path.join(root, 'assets/worker.js'));
  for (const value of ['pomelo://evil/login', 'file:///secret', 'pomelo://app/%2e%2e%5csecret', 'pomelo://app/%00secret', 'pomelo://app/%2f..%2fsecret'])
    assert.equal(resolveResource(root, value), null);
  assert.equal(sameOrigin('pomelo://evil', 'pomelo://app'), false);
  const frame = { url: 'pomelo://app/desktop-assistant' };
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  assert.equal(trustedFrame({ sender: contents, senderFrame: frame }, window, 'pomelo://app', 'assistant'), true);
  assert.equal(trustedFrame({ sender: contents, senderFrame: frame }, window, 'pomelo://app', 'main'), false);
});
test('remembered auth is encrypted, scoped by server, removable and fails closed on corruption', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pomelo-settings-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let available = true;
  const crypto = { isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(value).map(byte => byte ^ 0x55),
    decryptString: value => Buffer.from(value).map(byte => byte ^ 0x55).toString() };
  const auth = { token: 'sensitive-token', user: { id: 1, username: 'a', name: 'A', avatar: '', phone: '', signature: '', created_at: '' } };
  const settings = createSettings(directory, crypto, validAuth);
  settings.setServer('https://a.example.com'); settings.remember(auth);
  assert.deepEqual(createSettings(directory, crypto, validAuth).restore(), auth);
  for (const file of fs.readdirSync(directory)) assert(!fs.readFileSync(path.join(directory, file), 'utf8').includes(auth.token));
  settings.setServer('https://b.example.com'); assert.equal(settings.restore(), null);
  settings.setServer('https://a.example.com'); assert.deepEqual(settings.restore(), auth);
  settings.forget(); assert.equal(settings.restore(), null);
  available = false; assert.throws(() => settings.remember(auth));
  available = true; settings.remember(auth);
  const file = fs.readdirSync(directory).find(name => name.startsWith('session-'));
  fs.writeFileSync(path.join(directory, file), '{}'); assert.equal(settings.restore(), null);
});
