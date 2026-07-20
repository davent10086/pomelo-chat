require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeUploadMetadata } = require('../src/utils/file');

const validHash = 'a'.repeat(64);
assert.deepEqual(normalizeUploadMetadata(validHash, '.png'), {
	fileHash: validHash,
	ext: 'png',
	suffix: 'image'
});
assert.equal(normalizeUploadMetadata('../escape', 'png'), null);
assert.equal(normalizeUploadMetadata(validHash, '../png'), null);
assert.equal(normalizeUploadMetadata(validHash, 'png/evil'), null);

const readSource = (...segments) =>
	fs.readFileSync(path.join(__dirname, '..', 'src', ...segments), 'utf8');

const routes = readSource('controller', 'routes', 'auth.ts');
assert.match(routes, /router\.post\('\/logout', authenticateToken, auth\.logout\)/);
assert.match(routes, /router\.post\('\/forget_password', authenticateToken, auth\.forgetPassword\)/);

const auth = readSource('service', 'auth', 'index.ts');
assert.match(auth, /const username = req\.user\?\.username;/);
assert.doesNotMatch(auth, /const \{[^}]*username[^}]*\} = req\.body \|\| \{\};\s*\n\s*const userToken = generateToken\(username\)/);
assert.match(auth, /bcrypt\.compare\(currentPassword, user\.password\)/);
assert.match(auth, /better_chat\.del\(`token:\$\{req\.user!\.username\}`\)/);

const app = readSource('controller', 'app.ts');
assert.match(app, /app\.use\('\/uploads', authenticateUploadAccess, staticDownload, express\.static\('uploads'\)\)/);

const authenticate = readSource('utils', 'authenticate.ts');
assert.match(authenticate, /export const authenticateUploadAccess/);
assert.match(authenticate, /verifyTokenWithSession\(token\)/);

const message = readSource('service', 'message', 'index.ts');
assert.match(message, /verifyTokenWithSession/);
assert.match(message, /authorizeChatRoom/);

const rtc = readSource('service', 'rtc', 'index.ts');
assert.match(rtc, /verifyTokenWithSession/);

console.log('Security regression checks passed.');
