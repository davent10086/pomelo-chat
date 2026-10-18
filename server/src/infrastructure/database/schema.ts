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
    UNIQUE KEY uniq_file_owner_hash_ext (owner_id, file_hash, ext),
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
	confirmation_id VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_assistant_memory_user (user_id),
	INDEX idx_assistant_memory_category (user_id, category),
	UNIQUE KEY uniq_assistant_memory_action (user_id, confirmation_id)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const assistantTaskTableSQL = () => `
  CREATE TABLE IF NOT EXISTS assistant_task (
    id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT(11) NOT NULL,
    source_room VARCHAR(255) NULL,
    confirmation_id VARCHAR(64) NULL,
    source_index INT NULL,
    title VARCHAR(500) NOT NULL,
    assignee VARCHAR(255) NULL,
    due VARCHAR(255) NULL,
    status ENUM('open', 'completed') NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_assistant_task_user_status (user_id, status),
    INDEX idx_assistant_task_source_room (user_id, source_room),
    UNIQUE KEY uniq_assistant_task_action (user_id, confirmation_id, source_index),
    FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
`;
const assistantActionTableSQL = () => `
  CREATE TABLE IF NOT EXISTS assistant_action (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    user_id INT(11) NOT NULL,
    type VARCHAR(32) NOT NULL,
    payload JSON NOT NULL,
    selection JSON NULL,
    result JSON NULL,
    status ENUM('pending', 'executing', 'completed', 'cancelled') NOT NULL DEFAULT 'pending',
    expires_at DATETIME NOT NULL,
    lease_until DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_assistant_action_user (user_id, created_at),
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

const messageAttachmentTableSQL = () => `CREATE TABLE IF NOT EXISTS message_attachment (
		 message_id INT NOT NULL, file_id INT NOT NULL, PRIMARY KEY(message_id, file_id), INDEX idx_attachment_file(file_id),
		 FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE,
		 FOREIGN KEY(file_id) REFERENCES file_metadata(id) ON DELETE CASCADE
		) ENGINE=InnoDB`;
const messageOutboxTableSQL = () => `CREATE TABLE IF NOT EXISTS message_outbox (
		 message_id INT NOT NULL PRIMARY KEY, conversation_id INT NOT NULL, attempts INT NOT NULL DEFAULT 0,
		 next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME NULL,
		 INDEX idx_outbox_pending(delivered_at, next_attempt_at),
		 INDEX idx_outbox_room_pending(conversation_id, delivered_at, message_id),
		 FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE
		) ENGINE=InnoDB`;

/** Ordered by foreign-key dependencies. */
export const initialSchema = [
	userTableSQL(),
	friendGroupTableSQL(),
	friendTableSQL(),
	groupChatTableSQL(),
	groupMembersTableSQL(),
	conversationTableSQL(),
	messageTableSQL(),
	messageStatisticsTableSQL(),
	conversationReadTableSQL(),
	fileMetadataTableSQL(),
	messageAttachmentTableSQL(),
	messageOutboxTableSQL(),
	assistantMemoryTableSQL(),
	assistantTaskTableSQL(),
	assistantActionTableSQL(),
	mcpAuditLogTableSQL(),
	schemaMigrationTableSQL()
];
