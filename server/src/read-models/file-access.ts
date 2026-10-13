import { Query } from '../infrastructure/database-query';
export const canDownloadFile = async (
	storagePath: string,
	userId: number | string
): Promise<boolean> => {
	const rows = await Query<Array<{ ok: number }>>(
		`SELECT 1 AS ok FROM file_metadata f
			 WHERE f.storage_path = ? AND f.status = 'ready' AND (
				f.owner_id = ? OR EXISTS (
					SELECT 1 FROM message_attachment ma JOIN message m ON m.id = ma.message_id
					WHERE ma.file_id = f.id AND (
					 (m.type = 'private' AND EXISTS (SELECT 1 FROM friend fr JOIN friend_group fg ON fg.id = fr.group_id WHERE fr.room = m.room AND fg.user_id = ?))
					 OR (m.type = 'group' AND EXISTS (SELECT 1 FROM group_chat gc JOIN group_members gm ON gm.group_id = gc.id WHERE gc.room = m.room AND gm.user_id = ?))
					)
				)
				OR (f.media_type = 'image' AND EXISTS (SELECT 1 FROM user u WHERE u.id = f.owner_id AND u.avatar = f.storage_path))
				OR (f.media_type = 'image' AND EXISTS (SELECT 1 FROM group_chat gc WHERE gc.creator_id = f.owner_id AND gc.avatar = f.storage_path))
			 ) LIMIT 1`,
		[storagePath, userId, userId, userId]
	);
	return rows.length > 0;
};
