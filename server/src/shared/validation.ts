/** Accept decimal scalar IDs only; arrays, objects and coercible booleans are invalid. */
export const positiveId = (value: unknown): number | null => {
	if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export const boundedInteger = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number => {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	return Number(raw);
};
