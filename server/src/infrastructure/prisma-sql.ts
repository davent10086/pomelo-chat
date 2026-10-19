import { Prisma } from '../generated/prisma/client';
import type { OrmClient } from './prisma';
import { normalizeDatabaseValue, encodeDatabaseValues } from './prisma';

const identifier = (key: string): Prisma.Sql => {
	if (!/^[a-z_][a-z0-9_]*$/i.test(key)) throw new Error('Invalid SQL assignment column');
	return Prisma.raw('`' + key + '`');
};
const parameter = (value: unknown): Prisma.Sql => {
	if (Array.isArray(value)) {
		if (!value.length) throw new Error('Empty SQL list');
		return Prisma.join(
			value.map(item => (Array.isArray(item) ? Prisma.sql`(${parameter(item)})` : parameter(item)))
		);
	}
	if (
		value &&
		typeof value === 'object' &&
		!(value instanceof Date) &&
		!(value instanceof Uint8Array)
	) {
		const entries = Object.entries(value);
		if (!entries.length) throw new Error('Empty SQL assignment');
		return Prisma.join(
			entries.map(
				([key, child]) => Prisma.sql`${identifier(key)} = ${encodeDatabaseValues(child ?? null)}`
			)
		);
	}
	return Prisma.sql`${encodeDatabaseValues(value ?? null)}`;
};

/** Convert existing mysql2 placeholders to bound Prisma SQL; never interpolate values as text. */
export const bindSql = (text: string, bindings?: unknown): Prisma.Sql => {
	const values = bindings === undefined ? [] : Array.isArray(bindings) ? bindings : [bindings];
	const parts: Prisma.Sql[] = [];
	let start = 0,
		index = 0,
		quote = '',
		comment = '';
	for (let offset = 0; offset < text.length; offset++) {
		const char = text[offset],
			next = text[offset + 1];
		if (comment === 'line') {
			if (char === '\n') comment = '';
			continue;
		}
		if (comment === 'block') {
			if (char === '*' && next === '/') {
				offset++;
				comment = '';
			}
			continue;
		}
		if (quote) {
			if (char === '\\') {
				offset++;
				continue;
			}
			if (char === quote) {
				if (next === quote) offset++;
				else quote = '';
			}
			continue;
		}
		if (char === "'" || char === '"' || char === '`') {
			quote = char;
			continue;
		}
		if (char === '#') {
			comment = 'line';
			continue;
		}
		if (char === '-' && next === '-' && /\s/.test(text[offset + 2] || '')) {
			comment = 'line';
			offset++;
			continue;
		}
		if (char === '/' && next === '*') {
			comment = 'block';
			offset++;
			continue;
		}
		if (char !== '?') continue;
		if (next === '?' || index >= values.length) throw new Error('Invalid SQL bindings');
		parts.push(Prisma.raw(text.slice(start, offset)), parameter(values[index++]));
		start = offset + 1;
	}
	if (index !== values.length || quote || comment === 'block')
		throw new Error('Invalid SQL bindings');
	parts.push(Prisma.raw(text.slice(start)));
	return Prisma.join(parts, '');
};

export const executeSql = async <T>(
	client: OrmClient,
	text: string,
	bindings?: unknown
): Promise<T> => {
	const sql = bindSql(text, bindings);
	if (/^\s*(SELECT|SHOW|EXPLAIN|DESCRIBE|WITH)\b/i.test(text))
		return normalizeDatabaseValue(await client.$queryRaw(sql)) as T;
	const affectedRows = await client.$executeRaw(sql);
	if (/^\s*INSERT\b/i.test(text)) {
		// Caller supplies a transaction for INSERT so LAST_INSERT_ID uses that same connection.
		const rows = await client.$queryRaw<Array<{ id: bigint }>>`SELECT LAST_INSERT_ID() AS id`;
		return { affectedRows, insertId: normalizeDatabaseValue(rows[0].id) } as T;
	}
	return { affectedRows } as T;
};
