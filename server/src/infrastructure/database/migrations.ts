import type * as mysql from 'mysql2';
import { initialSchema } from './schema';

/** Each run owns one connection and holds the migration lock through all repairs. */
export const initializeDatabase = async (
	pool: mysql.Pool,
	assertConfiguration: () => void
): Promise<void> => {
	let connection: mysql.PoolConnection | undefined;

	const runSql = <T = unknown>(sql: string, values?: unknown): Promise<T> =>
		new Promise((resolve, reject) => {
			(connection || pool).query(sql, values as mysql.QueryValues, (error, results) =>
				error ? reject(error) : resolve(results as T)
			);
		});

	const runMigrationSql = async (name: string, sql: string): Promise<void> => {
		try {
			await runSql(sql);
		} catch (caught: unknown) {
			const err = caught as { code?: string; message?: string };
			if (
				err.code === 'ER_DUP_FIELDNAME' ||
				err.code === 'ER_DUP_KEYNAME' ||
				err.code === 'ER_TABLE_EXISTS_ERROR'
			) {
				return;
			}
			// eslint-disable-next-line no-console
			console.error(`[db:migration] ${name} failed:`, err.message || String(caught));
			throw caught;
		}
	};

	const isMigrationApplied = async (name: string): Promise<boolean> => {
		const rows = await runSql<Array<{ id: string }>>(
			'SELECT id FROM schema_migrations WHERE id = ? LIMIT 1',
			[name]
		);
		return rows.length > 0;
	};

	const recordMigration = async (name: string): Promise<void> => {
		await runSql('INSERT INTO schema_migrations (id) VALUES (?)', [name]);
	};

	const repairSystemData = async (): Promise<void> => {
		const name = 'system_integrity_v1';
		if (await isMigrationApplied(name)) return;
		await runMigrationSql('friend_owner', 'ALTER TABLE friend ADD COLUMN owner_id INT NULL');
		await runSql(
			'UPDATE friend f JOIN friend_group fg ON fg.id = f.group_id SET f.owner_id = fg.user_id WHERE f.owner_id IS NULL'
		);
		const contacts = await runSql<unknown[]>(
			'SELECT owner_id, user_id FROM friend WHERE owner_id IS NOT NULL GROUP BY owner_id, user_id HAVING COUNT(*) > 1 LIMIT 1'
		);
		const phones = await runSql<unknown[]>(
			'SELECT phone FROM user GROUP BY phone HAVING COUNT(*) > 1 LIMIT 1'
		);
		if (contacts.length || phones.length)
			throw new Error(
				'Resolve duplicate contacts/phone numbers before applying system_integrity_v1; no user histories were deleted'
			);
		await runMigrationSql(
			'friend_owner_unique',
			'ALTER TABLE friend ADD UNIQUE KEY uniq_friend_owner_user(owner_id, user_id)'
		);
		await runMigrationSql(
			'user_phone_unique',
			'ALTER TABLE user ADD UNIQUE KEY uniq_user_phone(phone)'
		);
		await runSql('START TRANSACTION');
		try {
			await runSql(`CREATE TEMPORARY TABLE repaired_message_seq AS SELECT id, room, room_seq AS old_seq,
			 ROW_NUMBER() OVER (PARTITION BY room ORDER BY id) AS new_seq FROM message`);
			await runSql(`UPDATE conversation_read cr JOIN conversation c ON c.id = cr.conversation_id
			 SET cr.last_read_seq = (SELECT COALESCE(MAX(r.new_seq), 0) FROM repaired_message_seq r WHERE r.room = c.room AND r.old_seq <= cr.last_read_seq AND r.old_seq > 0)`);
			await runSql(
				`UPDATE message m JOIN repaired_message_seq r ON r.id = m.id JOIN conversation c ON c.room = m.room SET m.room_seq = r.new_seq, m.conversation_id = c.id`
			);
			await runSql(
				`UPDATE conversation c LEFT JOIN (SELECT room, COUNT(*) AS total, MAX(id) AS last_id FROM message GROUP BY room) m ON m.room = c.room SET c.last_seq = COALESCE(m.total, 0), c.last_message_id = m.last_id`
			);
			await runSql(
				`INSERT IGNORE INTO message_attachment(message_id, file_id) SELECT m.id, f.id FROM message m JOIN file_metadata f ON f.owner_id = m.sender_id AND f.storage_path = m.content WHERE m.media_type <> 'text' AND m.media_type = f.media_type AND f.status = 'ready'`
			);
			await recordMigration(name);
			await runSql('COMMIT');
		} catch (err) {
			await runSql('ROLLBACK');
			throw err;
		} finally {
			await runSql('DROP TEMPORARY TABLE IF EXISTS repaired_message_seq');
		}
	};

	const runCompatibilityMigrations = async (): Promise<void> => {
		const migrations: Array<[string, string]> = [
			['message_original_file_name', 'ALTER TABLE message ADD COLUMN file_name VARCHAR(255) NULL'],
			['outbox_claim_token', 'ALTER TABLE message_outbox ADD COLUMN claim_token VARCHAR(36) NULL'],
			['outbox_lease_until', 'ALTER TABLE message_outbox ADD COLUMN lease_until DATETIME NULL'],
			[
				'message_add_conversation_id',
				'ALTER TABLE message ADD COLUMN conversation_id INT(11) NULL AFTER id'
			],
			[
				'message_add_client_msg_id',
				'ALTER TABLE message ADD COLUMN client_msg_id VARCHAR(64) NULL AFTER conversation_id'
			],
			[
				'message_add_room_seq',
				'ALTER TABLE message ADD COLUMN room_seq BIGINT NOT NULL DEFAULT 0 AFTER client_msg_id'
			],
			[
				'message_idx_room_type_id',
				'ALTER TABLE message ADD INDEX idx_message_room_type_id (room, type, id)'
			],
			['message_idx_room_id', 'ALTER TABLE message ADD INDEX idx_message_room_id (room, id)'],
			[
				'message_idx_room_created',
				'ALTER TABLE message ADD INDEX idx_message_room_created (room, created_at)'
			],
			[
				'message_idx_receiver_status',
				'ALTER TABLE message ADD INDEX idx_message_receiver_status (receiver_id, status, room)'
			],
			[
				'message_idx_conversation_seq',
				'ALTER TABLE message ADD INDEX idx_message_conversation_seq (conversation_id, room_seq)'
			],
			[
				'message_uniq_client',
				'ALTER TABLE message ADD UNIQUE KEY uniq_message_client (sender_id, client_msg_id)'
			],
			[
				'message_statistics_dedupe_room',
				'DELETE ms1 FROM message_statistics ms1 INNER JOIN message_statistics ms2 ON ms1.room = ms2.room AND ms1.id > ms2.id'
			],
			[
				'message_statistics_uniq_room',
				'ALTER TABLE message_statistics ADD UNIQUE KEY uniq_message_statistics_room (room)'
			],
			['friend_idx_room', 'ALTER TABLE friend ADD INDEX idx_friend_room (room)'],
			[
				'friend_idx_group_user',
				'ALTER TABLE friend ADD INDEX idx_friend_group_user (group_id, user_id)'
			],
			['group_chat_idx_room', 'ALTER TABLE group_chat ADD INDEX idx_group_chat_room (room)'],
			[
				'group_members_uniq_group_user',
				'ALTER TABLE group_members ADD UNIQUE KEY uniq_group_members_group_user (group_id, user_id)'
			],
			[
				'assistant_task_confirmation_id',
				'ALTER TABLE assistant_task ADD COLUMN confirmation_id VARCHAR(64) NULL'
			],
			[
				'assistant_task_source_index',
				'ALTER TABLE assistant_task ADD COLUMN source_index INT NULL'
			],
			[
				'assistant_task_action_unique',
				'ALTER TABLE assistant_task ADD UNIQUE KEY uniq_assistant_task_action (user_id, confirmation_id, source_index)'
			],
			[
				'assistant_memory_confirmation_id',
				'ALTER TABLE assistant_memory ADD COLUMN confirmation_id VARCHAR(64) NULL'
			],
			[
				'assistant_memory_action_unique',
				'ALTER TABLE assistant_memory ADD UNIQUE KEY uniq_assistant_memory_action (user_id, confirmation_id)'
			]
		];
		for (const [name, sql] of migrations) {
			if (await isMigrationApplied(name)) continue;
			await runMigrationSql(name, sql);
			await recordMigration(name);
		}

		const fileMetadataMigration = 'file_metadata_owner_hash_unique';
		if (!(await isMigrationApplied(fileMetadataMigration))) {
			const desiredIndex = await runSql<Array<{ Key_name: string }>>(
				'SHOW INDEX FROM file_metadata WHERE Key_name = ?',
				['uniq_file_owner_hash_ext']
			);
			if (!desiredIndex.length) {
				const legacyIndex = await runSql<Array<{ Key_name: string }>>(
					'SHOW INDEX FROM file_metadata WHERE Key_name = ?',
					['uniq_file_hash_ext']
				);
				if (legacyIndex.length)
					await runMigrationSql(
						fileMetadataMigration,
						'ALTER TABLE file_metadata DROP INDEX uniq_file_hash_ext'
					);
				await runMigrationSql(
					fileMetadataMigration,
					'ALTER TABLE file_metadata ADD UNIQUE KEY uniq_file_owner_hash_ext (owner_id, file_hash, ext)'
				);
			}
			await recordMigration(fileMetadataMigration);
		}
	};

	const backfillCompatibilityData = async (): Promise<void> => {
		const backfills: Array<[string, string]> = [
			[
				'conversation_backfill_from_messages',
				`INSERT IGNORE INTO conversation (room, type, target_id, last_message_id, last_seq, updated_at)
				 SELECT room, type, receiver_id, MAX(id), MAX(id), MAX(created_at)
				 FROM message
				 GROUP BY room, type, receiver_id`
			],
			[
				'message_backfill_conversation_seq',
				`UPDATE message m
				 INNER JOIN conversation c ON c.room = m.room
				 SET m.conversation_id = c.id, m.room_seq = CASE WHEN m.room_seq = 0 THEN m.id ELSE m.room_seq END
				 WHERE m.conversation_id IS NULL OR m.room_seq = 0`
			]
		];
		for (const [name, sql] of backfills) {
			if (await isMigrationApplied(name)) continue;
			await runMigrationSql(name, sql);
			await recordMigration(name);
		}
	};

	const migrateOutboxRoomIndex = async (): Promise<void> => {
		const name = 'outbox_pending_conversation_v1';
		if (await isMigrationApplied(name)) return;
		await runMigrationSql(name, 'ALTER TABLE message_outbox ADD COLUMN conversation_id INT NULL');
		await runSql(`UPDATE message_outbox o JOIN message m ON m.id = o.message_id
		 SET o.conversation_id = m.conversation_id WHERE o.conversation_id IS NULL`);
		await runSql('ALTER TABLE message_outbox MODIFY COLUMN conversation_id INT NOT NULL');
		await runMigrationSql(name,
			'ALTER TABLE message_outbox ADD INDEX idx_outbox_room_pending(conversation_id, delivered_at, message_id)');
		await recordMigration(name);
	};

	try {
		assertConfiguration();
		connection = await new Promise<mysql.PoolConnection>((resolve, reject) =>
			pool.getConnection((error, connection) => (error ? reject(error) : resolve(connection)))
		);
		const locks = await runSql<Array<{ acquired: number }>>(
			"SELECT GET_LOCK('pomelo_schema_migration', 60) AS acquired"
		);
		if (Number(locks[0]?.acquired) !== 1) throw new Error('Migration lock unavailable');
		for (const sql of initialSchema) await runSql(sql);
		await runCompatibilityMigrations();
		await backfillCompatibilityData();
		await repairSystemData();
		await migrateOutboxRoomIndex();
		// eslint-disable-next-line no-console
		console.log('MySQL 数据表初始化/迁移完成');
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		// eslint-disable-next-line no-console
		console.error('MySQL 数据表初始化/迁移失败:', err.message);
		throw err;
	} finally {
		if (connection) {
			await runSql("SELECT RELEASE_LOCK('pomelo_schema_migration')").catch(() => undefined);
			connection.release();
			connection = undefined;
		}
	}
};
