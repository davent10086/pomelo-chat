require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { uploadChunk } = require('../src/modules/files/public');
const { prisma } = require('../src/infrastructure/prisma');
const { withTransaction } = require('../src/infrastructure/database-query');
(async () => {
	assert.equal(
		(
			await uploadChunk(
				{ id: 1, username: 'owner' },
				{ chunkIndex: '1', fileHash: 'a'.repeat(64), extname: 'png' }
			)
		).code,
		1003
	);
	const original = prisma.$transaction;
	const operations = [];
	prisma.$transaction = async operation => {
		operations.push('begin');
		try {
			const value = await operation({ $executeRaw: async query => { operations.push(query.sql); return 1; } });
			operations.push('commit'); return value;
		} catch (error) { operations.push('rollback'); throw error; }
		finally { operations.push('release'); }
	};
	try {
		await withTransaction(async query => {
			await query('first write');
			await query('second write');
		});
		assert.deepEqual(operations, ['begin', 'first write', 'second write', 'commit', 'release']);
		operations.length = 0;
		await assert.rejects(
			withTransaction(async query => {
				await query('partial write');
				throw new Error('injected failure');
			}),
			/injected failure/
		);
		assert.deepEqual(operations, ['begin', 'partial write', 'rollback', 'release']);
		let attempts = 0;
		await withTransaction(
			async () => {
				if (++attempts < 3)
					throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
			},
			{ maxAttempts: 3 }
		);
		assert.equal(attempts, 3);
		attempts = 0;
		await assert.rejects(
			withTransaction(
				async () => {
					attempts++;
					throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
				},
				{ maxAttempts: 3 }
			),
			/deadlock/
		);
		assert.equal(attempts, 3, 'retries are bounded');
		attempts = 0;
		await assert.rejects(
			withTransaction(
				async () => {
					attempts++;
					throw Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
				},
				{ maxAttempts: 3 }
			),
			/connection lost/
		);
		assert.equal(attempts, 1, 'ambiguous failures are never retried');
	} finally {
		prisma.$transaction = original;
	}
	console.log(
		'[p2-regressions] upload rejection and transaction commit/rollback/release behavior passed'
	);
})().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
