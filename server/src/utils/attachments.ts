import { Query } from './query';

export type SqlQuery = <T = unknown>(sql: string, values?: unknown) => Promise<T>;

/** Only canonical, local upload paths are accepted as attachment identities. */
export const uploadPath = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	return /^\/uploads\/[1-9]\d*\/(image|video|file)\/([a-f0-9]{32}|[a-f0-9]{64})\.[a-z0-9]{1,10}$/.test(
		value
	)
		? value
		: null;
};

export const assertOwnedAvatar = async (
	userId: number | string,
	avatar: unknown
): Promise<void> => {
	if (avatar === null || avatar === undefined || avatar === '') return;
	const path = uploadPath(avatar);
	if (!path) {
		try {
			const url = new URL(String(avatar));
			if (
				url.protocol === 'https:' &&
				url.hostname === 'ui-avatars.com' &&
				url.pathname === '/api/'
			)
				return;
		} catch {
			/* invalid URL */
		}
		throw new Error('Invalid avatar path');
	}
	const rows = await Query<unknown[]>(
		"SELECT id FROM file_metadata WHERE storage_path = ? AND owner_id = ? AND media_type = 'image' AND status = 'ready' LIMIT 1",
		[path, userId]
	);
	if (!rows.length) throw new Error('Avatar access denied');
};

export const attachOwnedFile = async (
	query: SqlQuery,
	messageId: number,
	ownerId: number | string,
	content: string,
	mediaType: string
): Promise<number> => {
	const path = uploadPath(content);
	if (!path) throw new Error('Invalid attachment path');
	const rows = await query<Array<{ id: number; size: number; media_type: string }>>(
		"SELECT id, size, media_type FROM file_metadata WHERE storage_path = ? AND owner_id = ? AND status = 'ready' LIMIT 1 FOR UPDATE",
		[path, ownerId]
	);
	if (!rows.length || rows[0].media_type !== mediaType) throw new Error('Attachment access denied');
	await query('INSERT INTO message_attachment (message_id, file_id) VALUES (?, ?)', [
		messageId,
		rows[0].id
	]);
	return Number(rows[0].size);
};
