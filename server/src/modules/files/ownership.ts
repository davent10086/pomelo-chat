import * as repository from './repository';

import type { SqlQuery } from '../../shared/actor';

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
	const rows = await repository.findOwnedAvatar<unknown[]>([path, userId]);
	if (!rows.length) throw new Error('Avatar access denied');
};

export const lockOwnedFile = async (
	query: SqlQuery,

	ownerId: number | string,
	content: string,
	mediaType: string
): Promise<{ fileId: number; size: number }> => {
	const path = uploadPath(content);
	if (!path) throw new Error('Invalid attachment path');
	const rows = await repository.lockOwnedReadyFile<
		Array<{ id: number; size: number; media_type: string }>
	>([path, ownerId], query);
	if (!rows.length || rows[0].media_type !== mediaType) throw new Error('Attachment access denied');
	return { fileId: rows[0].id, size: Number(rows[0].size) };
};
