import { Query, withTransaction } from '../../infrastructure/database-query';
import type { SqlQuery } from '../../shared/actor';
import { ormQuery } from '../../infrastructure/prisma';
import { boundedInteger } from '../../shared/validation';

const storageBudget = boundedInteger('MAX_USER_STORAGE_BYTES', 500 * 1024 * 1024, 1);
export class StorageQuotaExceeded extends Error {}

/** Reserve before committing bytes. SQL survives Redis eviction and serializes different files for one owner. */
export const reserveFileStorage = async (bindings: [number | string, string, string, string, string, number, null]): Promise<void> => {
	const [ownerId, hash, ext, , , size] = bindings;
	await withTransaction(async executor => {
		const owner = await executor<Array<{ id: number }>>('SELECT id FROM user WHERE id = ? FOR UPDATE', [ownerId]);
		if (!owner.length) throw new Error('Upload owner no longer exists');
		const files = await executor<Array<{ file_hash: string; ext: string; size: number }>>(
			'SELECT file_hash, ext, size FROM file_metadata WHERE owner_id = ? FOR UPDATE', [ownerId]
		);
		const total = files.reduce((sum, file) => sum + BigInt(file.size), 0n);
		const prior = files.find(file => file.file_hash === hash && file.ext === ext);
		const delta = BigInt(size) - BigInt(prior?.size || 0);
		if (delta > 0n && total + delta > BigInt(storageBudget))
			throw new StorageQuotaExceeded('Stored files exceed user storage budget');
		await executor(
			`INSERT INTO file_metadata (owner_id, file_hash, ext, media_type, storage_path, size, mime, status)
 VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading') ON DUPLICATE KEY UPDATE size = VALUES(size)`, bindings
		);
	});
};

export const releaseUnfinishedStorage = (ownerId: string, hash: string, ext: string) => Query(
	"DELETE FROM file_metadata WHERE owner_id = ? AND file_hash = ? AND ext = ? AND status = 'uploading'",
	[ownerId, hash, ext]
);
export const upsertReadyFile = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		`INSERT INTO file_metadata (owner_id, file_hash, ext, media_type, storage_path, size, mime, status)
 VALUES (?, ?, ?, ?, ?, ?, ?, 'ready') ON DUPLICATE KEY UPDATE storage_path = VALUES(storage_path), size = VALUES(size), status = 'ready', updated_at = CURRENT_TIMESTAMP`,
		bindings
	);
};

export const markFileUploading = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const [ownerId, fileHash, ext] = bindings as [number | string, string, string];
	return ormQuery<T>(
		executor,
		db =>
			db.file_metadata
				.updateMany({
					where: { owner_id: Number(ownerId), file_hash: fileHash, ext },
					data: { status: 'uploading' }
				})
				.then(result => ({ affectedRows: result.count })),
		() =>
			executor<T>(
				"UPDATE file_metadata SET status = 'uploading' WHERE owner_id = ? AND file_hash = ? AND ext = ?",
				bindings
			)
	);
};

export const findOwnedAvatar = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	const [storagePath, ownerId] = bindings as [string, number | string];
	return ormQuery<T>(
		executor,
		db =>
			db.file_metadata.findMany({
				where: {
					storage_path: storagePath,
					owner_id: Number(ownerId),
					media_type: 'image',
					status: 'ready'
				},
				select: { id: true },
				take: 1
			}),
		() =>
			executor<T>(
				"SELECT id FROM file_metadata WHERE storage_path = ? AND owner_id = ? AND media_type = 'image' AND status = 'ready' LIMIT 1",
				bindings
			)
	);
};

export const lockOwnedReadyFile = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		"SELECT id, size, media_type FROM file_metadata WHERE storage_path = ? AND owner_id = ? AND status = 'ready' LIMIT 1 FOR UPDATE",
		bindings
	);
};
