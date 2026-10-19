export const validateRealtimeConfig = (): void => {
	for (const name of ['REALTIME_DRIVER', 'OUTBOX_DRIVER']) {
		if (!['node', 'go'].includes(process.env[name] || 'node')) throw new Error(`Invalid ${name}`);
	}
	if (
		[process.env.REALTIME_DRIVER, process.env.OUTBOX_DRIVER].includes('go') &&
		(process.env.REALTIME_INTERNAL_TOKEN?.length || 0) < 32
	)
		throw new Error('Go realtime requires REALTIME_INTERNAL_TOKEN of at least 32 characters');
};
