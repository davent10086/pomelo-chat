/** Bound fanout without creating one in-flight Redis operation per member. */
export const forEachConcurrent = async <T>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<void>
): Promise<void> => {
	let next = 0;
	let failed = false;
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				const item = items[next++];
				try {
					await fn(item);
				} catch (error) {
					failed = true;
					failure = error;
				}
			}
		})
	);
	if (failed) throw failure;
};
