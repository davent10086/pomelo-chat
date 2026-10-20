require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { positiveId } = require('../src/shared/validation');
const { requeueFailedOutbox } = require('../src/modules/messaging/repository');
const { closeDatabase } = require('../src/infrastructure/database');
const id = positiveId(process.argv[2]);
if (!id) throw new Error('Usage: pnpm outbox:retry <message_id>');
requeueFailedOutbox(id).then(result => {
  if (result.affectedRows !== 1) throw new Error('No failed pending message with that ID');
  console.log(`[outbox] message ${id} requeued; room ordering preserved`);
}).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(closeDatabase);
