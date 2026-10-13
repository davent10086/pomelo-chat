import { Query } from '../../infrastructure/database-query';
import type { SqlQuery } from '../../shared/actor';
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
	return executor<T>(
		"UPDATE file_metadata SET status = 'uploading' WHERE owner_id = ? AND file_hash = ? AND ext = ?",
		bindings
	);
};

export const findOwnedAvatar = <T = unknown>(
	bindings: unknown,
	executor: SqlQuery = Query
): Promise<T> => {
	return executor<T>(
		"SELECT id FROM file_metadata WHERE storage_path = ? AND owner_id = ? AND media_type = 'image' AND status = 'ready' LIMIT 1",
		bindings
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
