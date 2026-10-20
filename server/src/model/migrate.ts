import 'dotenv/config';

let activeDb: { end: () => void } | undefined;

const main = async () => {
	const { default: db, assertDatabaseConnection, initDatabase } = await import('../infrastructure/database');
	activeDb = db;
	await assertDatabaseConnection();
	await initDatabase();
	return db;
};

main()
	.then(db => {
		console.log('[db:migrate] completed');
		db.end();
	})
	.catch((caught: unknown) => {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		console.error('[db:migrate] failed:', err.message);
		activeDb?.end();
		process.exit(1);
	});
