require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { normalizeUploadMetadata } = require('../src/shared/file');
const queryModule = require('../src/infrastructure/database-query');
const { better_chat } = require('../src/infrastructure/redis');
const { createIdentityApplication } = require('../src/modules/identity/public');
const { createUploadAccessMiddleware } = require('../src/modules/files/access-http');
const { createRtcApplication } = require('../src/modules/rtc/public');
const validHash = 'a'.repeat(64);
assert.deepEqual(normalizeUploadMetadata(validHash, '.png'), {
	fileHash: validHash,
	ext: 'png',
	suffix: 'image'
});
for (const [hash, extension] of [
	['../escape', 'png'],
	[validHash, '../png'],
	[validHash, 'png/evil']
])
	assert.equal(normalizeUploadMetadata(hash, extension), null);
(async () => {
	const hash = await bcrypt.hash('current-password', 4);
	const mutations = [],
		revoked = [];
	queryModule.Query = async (sql, values) => {
		if (sql.startsWith('SELECT id, password')) return [{ id: 1, password: hash }];
		if (sql.startsWith('UPDATE user SET password')) {
			mutations.push(values);
			return { affectedRows: 1 };
		}
		if (sql.includes('FROM group_chat AS gc')) return [];
		throw new Error('unexpected query: ' + sql);
	};
	better_chat.del = async key => {
		revoked.push(key);
		return 1;
	};
	const app = createIdentityApplication({
		releaseUserCall: async () => {},
		notifySessionChanged: async () => {},
		updateContactPresence: async () => {},
		initializeDefaultFriendGroup: async () => {}
	});
	assert.equal(
		(
			await app.forgetPassword(
				{ id: 1, username: 'owner' },
				{ currentPassword: 'wrong', password: 'new-password' }
			)
		).code,
		2001
	);
	assert.equal(mutations.length, 0);
	assert.equal(
		(
			await app.forgetPassword(
				{ id: 1, username: 'owner' },
				{ currentPassword: 'current-password', password: 'new-password', username: 'victim' }
			)
		).code,
		200
	);
	assert.equal(mutations.length, 1);
	assert.equal(mutations[0][1], 1);
	assert.deepEqual(revoked, ['token:owner']);
	let accessStatus,
		nextCalled = false;
	const access = createUploadAccessMiddleware(
		async () => null,
		() => false
	);
	await access(
		{ headers: {}, query: {}, path: '/anything' },
		{
			status(code) {
				accessStatus = code;
				return this;
			},
			end() {}
		},
		() => {
			nextCalled = true;
		}
	);
	assert.equal(accessStatus, 401);
	assert.equal(nextCalled, false);
	const rtc = createRtcApplication({
		calls: {
			getCall: async () => {
				throw new Error('must not load unauthorized call');
			}
		},
		notifyUser: async () => {}
	});
	assert.equal(
		(
			await rtc.createJoinToken(
				{ id: 2, username: 'outsider' },
				{ room: 'private-room', type: 'group', callId: 'stolen' }
			)
		).code,
		1006
	);
	console.log(
		'[security] real password verification, actor-scoped mutation, revocation, upload authentication and RTC room authorization passed'
	);
	better_chat.disconnect();
})().catch(error => {
	console.error(error);
	better_chat.disconnect();
	process.exitCode = 1;
});
