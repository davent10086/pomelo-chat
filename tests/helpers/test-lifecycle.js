const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const TEST_RUN_ID = `test_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${crypto.randomUUID().slice(0, 8)}`;
const TEMP_ROOT = path.join(process.cwd(), 'tmp', 'tests', TEST_RUN_ID);

const assertSafeTestEnvironment = () => {
	assert.notEqual(process.env.NODE_ENV, 'production', 'tests must never run with NODE_ENV=production');
	assert.notEqual(process.env.APP_ENV, 'production', 'tests must never run with APP_ENV=production');
	for (const value of [process.env.DATABASE_URL_TEST, process.env.TEST_DATABASE_URL, process.env.DB_NAME]) {
		if (value) assert.doesNotMatch(value.toLowerCase(), /(^|[-_/])prod(uction)?($|[-_/])/, 'tests must not target production data');
	}
};

const createTestTempDirectory = async () => {
	assertSafeTestEnvironment();
	await fs.mkdir(TEMP_ROOT, { recursive: true });
	return TEMP_ROOT;
};

const cleanupTestArtifacts = async () => {
	await fs.rm(TEMP_ROOT, { recursive: true, force: true });
};

module.exports = { TEST_RUN_ID, TEMP_ROOT, assertSafeTestEnvironment, createTestTempDirectory, cleanupTestArtifacts };
