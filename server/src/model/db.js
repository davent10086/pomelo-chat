/* global process */
const mysql = require('mysql');
const fs = require('fs');
const path = require('path');

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

const configPath = path.join(process.cwd(), './config.json');
if (fs.existsSync(configPath)) {
	try {
		const res = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		// 仅在环境变量未设置时使用配置文件的值
		if (!process.env.DB_HOST) host = res.host || host;
		if (!process.env.DB_PORT) port = res.port || port;
		if (!process.env.DB_USER) user = res.user || user;
		if (!process.env.DB_PASSWORD) password = res.password || password;
		if (!process.env.DB_NAME) database = res.database || database;
	} catch (err) {
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
const runSql = (sql) => new Promise((resolve, reject) => {
	db.query(sql, error => (error ? reject(error) : resolve()));
});

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
    PRIMARY KEY (id)
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

// L4: 串行建表，保证外键依赖顺序
const initTables = async () => {
	try {
		// 顺序：user → friend_group → friend → group_chat → group_members → message → message_statistics
		await runSql(userTableSQL());
		await runSql(friendGroupTableSQL());
		await runSql(friendTableSQL());
		await runSql(groupChatTableSQL());
		await runSql(groupMembersTableSQL());
		await runSql(messageTableSQL());
		await runSql(messageStatisticsTableSQL());
		// eslint-disable-next-line no-console
		console.log('MySQL 数据表初始化完成');
	} catch (err) {
		// eslint-disable-next-line no-console
		console.error('MySQL 数据表初始化失败:', err.message);
	}
};

/**
 * 4、测试 mysql 模块能否正常工作
 */
db.query('select 1', async error => {
	if (error) {
		// eslint-disable-next-line no-console
		console.error('MySQL 连接失败', error.message);
		process.exit(1);
	}
	// eslint-disable-next-line no-console
	console.log('MySQL 连接成功');
	await initTables();
});

/**
 * 5、将连接好的数据库对象向外导出, 供外界使用
 */
module.exports = db;
