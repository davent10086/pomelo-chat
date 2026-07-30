import * as mysql from 'mysql';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 1、读取 MySQL 数据库配置
 * 优先级：环境变量 > config.json > 默认值
 * H7: 关闭 multipleStatements，默认密码改为空（强制走配置）
 * L4: 配置读取加 try/catch 保护
 */
let host = process.env.DB_HOST || '127.0.0.1';
let port = parseInt(process.env.DB_PORT || '3306', 10);
let user = process.env.DB_USER || 'root';
let password = process.env.DB_PASSWORD || '';
let database = process.env.DB_NAME || 'pomelo-chat';

const configPaths = [
	path.join(process.cwd(), './config.json'),
	path.join(__dirname, './config.json')
];
const configPath = configPaths.find(item => fs.existsSync(item));
if (configPath) {
	try {
		const res = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		// 仅在环境变量未设置时使用配置文件的值
		if (!process.env.DB_HOST) host = res.host || host;
		if (!process.env.DB_PORT) port = res.port || port;
		if (!process.env.DB_USER) user = res.user || user;
		if (!process.env.DB_PASSWORD) password = res.password || password;
		if (!process.env.DB_NAME) database = res.database || database;
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		// eslint-disable-next-line no-console
		console.error('[db] 读取 config.json 失败，使用默认/环境变量配置:', err.message);
	}
}

/**
 * 2. 建立与 MySQL 数据库的连接关系
 * H7: 关闭 multipleStatements 以防 SQL 注入堆叠执行
 */
const db = mysql.createPool({
	host,
	port,
	user,
	password,
	database,
	multipleStatements: false, // 关闭：防止 SQL 注入时堆叠执行破坏性语句
	charset: 'utf8mb4',
	connectionLimit: 10
});

/**
 * 3. 建表
 * L4: 改为串行化建表，保证外键依赖顺序
 */
const runSql = (sql: string): Promise<void> =>
	new Promise((resolve, reject) => {
		db.query(sql, error => (error ? reject(error) : resolve()));
	});

const runMigrationSql = async (name: string, sql: string): Promise<void> => {
	try {
		await runSql(sql);
	} catch (caught: unknown) {
		const err = caught as { code?: string; message?: string };
		if (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_TABLE_EXISTS_ERROR') {
			return;
		}
		// eslint-disable-next-line no-console
		console.error(`[db:migration] ${name} failed:`, err.message || String(caught));
		throw caught;
	}
};

// 表结构定义（独立函数，仅返回 SQL）
const userTableSQL = () => `
  CREATE TABLE IF NOT EXISTS user (
    id INT (11) NOT NULL AUTO_INCREMENT PRIMARY KEY, 
    username VARCHAR (255) NOT NULL UNIQUE, 
    password VARCHAR (255) NOT NULL, 
    phone VARCHAR (50) NOT NULL, 
    avatar VARCHAR (255) NULL, 
    name VARCHAR (255) NULL, 
    salt VARCHAR (20) NOT NULL DEFAULT '', 
    signature LONGTEXT NULL, 
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE = INNODB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const friendGroupTableSQL = () => `
  CREATE TABLE IF NOT EXISTS friend_group (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY, 
    user_id INT(11) NOT NULL, 
    username VARCHAR (255) NOT NULL, 
    name VARCHAR(50) NOT NULL, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
    INDEX idx_user_id (user_id), 
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const friendTableSQL = () => `
  CREATE TABLE IF NOT EXISTS friend (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY, 
    user_id INT(11) NOT NULL, 
    username VARCHAR(50) NOT NULL, 
    avatar VARCHAR (255) NULL, 
    online_status ENUM('online', 'offline') DEFAULT 'offline', 
    remark VARCHAR(50), 
    group_id INT(11), 
    room VARCHAR(255), 
    unread_msg_count INT(11) DEFAULT 0, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
    INDEX idx_group_id (group_id), 
    FOREIGN KEY (group_id) REFERENCES friend_group(id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const messageTableSQL = () => `
  CREATE TABLE IF NOT EXISTS message (
    id int(11) NOT NULL AUTO_INCREMENT, 
    conversation_id int(11) NULL,
    client_msg_id VARCHAR(64) NULL,
    room_seq BIGINT NOT NULL DEFAULT 0,
    sender_id int(11) NOT NULL, 
    receiver_id int(11) NOT NULL, 
    content longtext NOT NULL, 
    room VARCHAR(255) NOT NULL, 
    type enum('private', 'group') NOT NULL, 
    media_type enum('text', 'image', 'video', 'file') NOT NULL, 
    file_size int(11) NULL DEFAULT 0, 
    status int(1) NOT NULL DEFAULT 0, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
    PRIMARY KEY (id), 
    UNIQUE KEY uniq_message_client (sender_id, client_msg_id),
    INDEX idx_message_room_id (room, id),
    INDEX idx_message_room_created (room, created_at),
    INDEX idx_message_receiver_status (receiver_id, status, room),
    INDEX idx_message_conversation_seq (conversation_id, room_seq),
    FOREIGN KEY (sender_id) REFERENCES user(id) ON DELETE CASCADE ON UPDATE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const messageStatisticsTableSQL = () => `
  CREATE TABLE IF NOT EXISTS message_statistics (
    id int(11) NOT NULL AUTO_INCREMENT, 
    room VARCHAR(255) NOT NULL, 
    total int(255) NOT NULL, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
    PRIMARY KEY (id),
    UNIQUE KEY uniq_message_statistics_room (room)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const conversationTableSQL = () => `
  CREATE TABLE IF NOT EXISTS conversation (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
    room VARCHAR(255) NOT NULL,
    type ENUM('private', 'group', 'assistant') NOT NULL,
    target_id INT(11) NULL,
    last_message_id INT(11) NULL,
    last_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_conversation_room (room),
    INDEX idx_conversation_type_target (type, target_id),
    INDEX idx_conversation_updated (updated_at)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const conversationReadTableSQL = () => `
  CREATE TABLE IF NOT EXISTS conversation_read (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT(11) NOT NULL,
    user_id INT(11) NOT NULL,
    last_read_seq BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_conversation_read_user (conversation_id, user_id),
    INDEX idx_conversation_read_user (user_id, conversation_id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const fileMetadataTableSQL = () => `
  CREATE TABLE IF NOT EXISTS file_metadata (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
    owner_id INT(11) NOT NULL,
    file_hash VARCHAR(128) NOT NULL,
    ext VARCHAR(16) NOT NULL,
    media_type ENUM('image', 'video', 'file') NOT NULL,
    storage_path VARCHAR(500) NOT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    mime VARCHAR(128) NULL,
    status ENUM('uploading', 'ready', 'deleted') NOT NULL DEFAULT 'ready',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_file_hash_ext (file_hash, ext),
    INDEX idx_file_owner (owner_id, created_at),
    INDEX idx_file_status (status, updated_at),
    FOREIGN KEY (owner_id) REFERENCES user(id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const schemaMigrationTableSQL = () => `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(128) NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const groupChatTableSQL = () => `
  CREATE TABLE IF NOT EXISTS group_chat (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY, 
    name VARCHAR(50) NOT NULL, 
    creator_id INT(11) NOT NULL, 
    avatar VARCHAR(255), 
    announcement TEXT, 
    room VARCHAR(255), 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
    INDEX idx_creator_id (creator_id), 
    FOREIGN KEY (creator_id) REFERENCES user(id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const groupMembersTableSQL = () => `
  CREATE TABLE IF NOT EXISTS group_members (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY, 
    group_id INT(11) NOT NULL, 
    user_id INT(11) NOT NULL, 
    nickname VARCHAR(50) NOT NULL, 
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
    INDEX idx_user_id (user_id), 
    INDEX idx_group_id (group_id), 
    FOREIGN KEY (group_id) REFERENCES group_chat(id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const assistantMemoryTableSQL = () => `
  CREATE TABLE IF NOT EXISTS assistant_memory (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT(11) NOT NULL,
    category VARCHAR(32) NOT NULL DEFAULT 'preference',
    content VARCHAR(1000) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_assistant_memory_user (user_id),
    INDEX idx_assistant_memory_category (user_id, category)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const assistantTaskTableSQL = () => `
  CREATE TABLE IF NOT EXISTS assistant_task (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT(11) NOT NULL,
    source_room VARCHAR(255) NULL,
    title VARCHAR(500) NOT NULL,
    assignee VARCHAR(255) NULL,
    due VARCHAR(255) NULL,
    status ENUM('open', 'completed') NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_assistant_task_user_status (user_id, status),
    INDEX idx_assistant_task_source_room (user_id, source_room),
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const mcpAuditLogTableSQL = () => `
  CREATE TABLE IF NOT EXISTS mcp_audit_log (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT(11) NULL,
    server_name VARCHAR(128) NULL,
    tool VARCHAR(255) NOT NULL,
    event VARCHAR(64) NOT NULL,
    requires_confirmation TINYINT(1) NOT NULL DEFAULT 0,
    confirmed TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL,
    error_message VARCHAR(500) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_mcp_audit_user_created (user_id, created_at),
    INDEX idx_mcp_audit_tool_created (tool, created_at),
    INDEX idx_mcp_audit_server_created (server_name, created_at)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;

// L4: 串行建表，保证外键依赖顺序
export const initDatabase = async (): Promise<void> => {
	try {
		// 顺序：user → friend_group → friend → group_chat → group_members → message → message_statistics
		await runSql(userTableSQL());
		await runSql(friendGroupTableSQL());
		await runSql(friendTableSQL());
		await runSql(groupChatTableSQL());
		await runSql(groupMembersTableSQL());
		await runSql(conversationTableSQL());
		await runSql(messageTableSQL());
		await runSql(messageStatisticsTableSQL());
		await runSql(conversationReadTableSQL());
		await runSql(fileMetadataTableSQL());
		await runSql(assistantMemoryTableSQL());
		await runSql(assistantTaskTableSQL());
		await runSql(mcpAuditLogTableSQL());
		await runSql(schemaMigrationTableSQL());
		await runCompatibilityMigrations();
		await backfillCompatibilityData();
		// eslint-disable-next-line no-console
		console.log('MySQL 数据表初始化/迁移完成');
	} catch (caught: unknown) {
		const err = caught instanceof Error ? caught : new Error(String(caught));
		// eslint-disable-next-line no-console
		console.error('MySQL 数据表初始化/迁移失败:', err.message);
	}
};

const runCompatibilityMigrations = async (): Promise<void> => {
	const migrations: Array<[string, string]> = [
		['message_add_conversation_id', 'ALTER TABLE message ADD COLUMN conversation_id INT(11) NULL AFTER id'],
		['message_add_client_msg_id', 'ALTER TABLE message ADD COLUMN client_msg_id VARCHAR(64) NULL AFTER conversation_id'],
		['message_add_room_seq', 'ALTER TABLE message ADD COLUMN room_seq BIGINT NOT NULL DEFAULT 0 AFTER client_msg_id'],
		['message_idx_room_id', 'ALTER TABLE message ADD INDEX idx_message_room_id (room, id)'],
		['message_idx_room_created', 'ALTER TABLE message ADD INDEX idx_message_room_created (room, created_at)'],
		['message_idx_receiver_status', 'ALTER TABLE message ADD INDEX idx_message_receiver_status (receiver_id, status, room)'],
		['message_idx_conversation_seq', 'ALTER TABLE message ADD INDEX idx_message_conversation_seq (conversation_id, room_seq)'],
		['message_uniq_client', 'ALTER TABLE message ADD UNIQUE KEY uniq_message_client (sender_id, client_msg_id)'],
		['message_statistics_dedupe_room', 'DELETE ms1 FROM message_statistics ms1 INNER JOIN message_statistics ms2 ON ms1.room = ms2.room AND ms1.id > ms2.id'],
		['message_statistics_uniq_room', 'ALTER TABLE message_statistics ADD UNIQUE KEY uniq_message_statistics_room (room)'],
		['friend_idx_room', 'ALTER TABLE friend ADD INDEX idx_friend_room (room)'],
		['friend_idx_group_user', 'ALTER TABLE friend ADD INDEX idx_friend_group_user (group_id, user_id)'],
		['group_chat_idx_room', 'ALTER TABLE group_chat ADD INDEX idx_group_chat_room (room)'],
		['group_members_uniq_group_user', 'ALTER TABLE group_members ADD UNIQUE KEY uniq_group_members_group_user (group_id, user_id)']
	];
	for (const [name, sql] of migrations) {
		await runMigrationSql(name, sql);
		await runMigrationSql(`record_${name}`, `INSERT IGNORE INTO schema_migrations (id) VALUES ('${name}')`);
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
		await runMigrationSql(name, sql);
		await runMigrationSql(`record_${name}`, `INSERT IGNORE INTO schema_migrations (id) VALUES ('${name}')`);
	}
};

/**
 * 4、测试 mysql 模块能否正常工作
 */
export const assertDatabaseConnection = (): Promise<void> =>
	new Promise((resolve, reject) => {
		db.query('select 1', error => (error ? reject(error) : resolve()));
	});

if (process.env.POMELO_SKIP_AUTO_DB_INIT !== 'true') {
	db.query('select 1', async error => {
		if (error) {
			// eslint-disable-next-line no-console
			console.error('MySQL 连接失败', error.message);
			process.exit(1);
		}
		// eslint-disable-next-line no-console
		console.log('MySQL 连接成功');
		await initDatabase();
	});
}

/**
 * 5、将连接好的数据库对象向外导出, 供外界使用
 */
export default db;
