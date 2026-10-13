/** Cursor pagination preserves the existing array response contract. */
export const parseSearchPage = (query: {
	afterId?: unknown;
	limit?: unknown;
}): { afterId: number; limit: number } | null => {
	const parse = (value: unknown, fallback: number): number =>
		value === undefined
			? fallback
			: typeof value === 'string' && /^\d+$/.test(value)
				? Number(value)
				: NaN;
	const afterId = parse(query.afterId, 0);
	const limit = parse(query.limit, 30);
	return Number.isSafeInteger(afterId) &&
		afterId >= 0 &&
		Number.isSafeInteger(limit) &&
		limit > 0 &&
		limit <= 100
		? { afterId, limit }
		: null;
};

export const escapeSearchTerm = (value: string): string => value.replace(/[!%_]/g, '!$&');
