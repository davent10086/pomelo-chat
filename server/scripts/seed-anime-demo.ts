import 'dotenv/config';

process.env.POMELO_SKIP_AUTO_DB_INIT = 'true';

import bcrypt from 'bcrypt';

import db, { assertDatabaseConnection, initDatabase } from '../src/model/db';
import { withTransaction } from '../src/utils/query';

type WriteResult = { insertId: number };
type UserRow = { id: number; username: string; name: string; avatar: string };
type IdRow = { id: number };
type ConversationRow = { id: number; last_seq: number };

const PASSWORD = 'AnimeDemo123!';
const AVATAR_BASE = 'https://api.dicebear.com/10.x/lorelei/svg?backgroundType=gradientLinear&seed=';
const USERS = [
	{ username: 'bocchi_hitori', name: '后藤一里', phone: '13900010001', avatar: 'https://bocchi.rocks/tv/assets/img/page/character/hitori/main.png' },
	{ username: 'bocchi_nijika', name: '伊地知虹夏', phone: '13900010002', avatar: 'https://bocchi.rocks/tv/assets/img/page/character/nijika/main.png' },
	{ username: 'bocchi_ryo', name: '山田凉', phone: '13900010003', avatar: 'https://bocchi.rocks/tv/assets/img/page/character/ryo/main.png' },
	{ username: 'bocchi_kita', name: '喜多郁代', phone: '13900010004', avatar: 'https://bocchi.rocks/tv/assets/img/page/character/ikuyo/main.png' }
];

const queryUser = async <T>(query: <R>(sql: string, info?: unknown) => Promise<R>, sql: string, params?: unknown) =>
	query<T>(sql, params);

const ensureFriendGroup = async (query: <R>(sql: string, info?: unknown) => Promise<R>, userId: number) => {
	const rows = await queryUser<IdRow[]>(query, 'SELECT id FROM friend_group WHERE user_id = ? AND name = ? LIMIT 1', [userId, '二次元社团']);
	if (rows.length) return rows[0].id;
	const result = await queryUser<WriteResult>(query, 'INSERT INTO friend_group (user_id, username, name) VALUES (?, ?, ?)', [userId, String(userId), '二次元社团']);
	return result.insertId;
};

const ensureDirectRoom = async (query: <R>(sql: string, info?: unknown) => Promise<R>, owner: UserRow, friend: UserRow) => {
	const existing = await queryUser<Array<{ room: string }>>(
		query,
		`SELECT f.room FROM friend f JOIN friend_group fg ON fg.id = f.group_id
		 WHERE fg.user_id = ? AND f.user_id = ? LIMIT 1`,
		[owner.id, friend.id]
	);
	if (existing.length) return existing[0].room;
	const ownerGroup = await ensureFriendGroup(query, owner.id);
	const friendGroup = await ensureFriendGroup(query, friend.id);
	const room = `anime-direct-${[owner.id, friend.id].sort((a, b) => a - b).join('-')}`;
	await queryUser(query, 'INSERT INTO friend (user_id, username, avatar, online_status, remark, group_id, room) VALUES (?, ?, ?, ?, ?, ?, ?)', [friend.id, friend.username, friend.avatar, 'offline', friend.name, ownerGroup, room]);
	await queryUser(query, 'INSERT INTO friend (user_id, username, avatar, online_status, remark, group_id, room) VALUES (?, ?, ?, ?, ?, ?, ?)', [owner.id, owner.username, owner.avatar, 'offline', owner.name, friendGroup, room]);
	return room;
};

const ensureMessage = async (
	query: <R>(sql: string, info?: unknown) => Promise<R>,
	room: string,
	type: 'private' | 'group',
	targetId: number,
	senderId: number,
	content: string,
	clientMsgId: string
) => {
	const duplicate = await queryUser<IdRow[]>(query, 'SELECT id FROM message WHERE sender_id = ? AND client_msg_id = ? LIMIT 1', [senderId, clientMsgId]);
	if (duplicate.length) return;
	await queryUser(query, 'INSERT IGNORE INTO conversation (room, type, target_id) VALUES (?, ?, ?)', [room, type, targetId]);
	const conversation = (await queryUser<ConversationRow[]>(query, 'SELECT id, last_seq FROM conversation WHERE room = ? FOR UPDATE', [room]))[0];
	const nextSeq = Number(conversation.last_seq || 0) + 1;
	await queryUser(query, 'UPDATE conversation SET last_seq = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextSeq, conversation.id]);
	const inserted = await queryUser<WriteResult>(query,
		`INSERT INTO message (conversation_id, client_msg_id, room_seq, sender_id, receiver_id, content, room, type, media_type, file_size, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'text', 0, 1)`,
		[conversation.id, clientMsgId, nextSeq, senderId, targetId, content, room, type]
	);
	await queryUser(query, 'UPDATE conversation SET last_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [inserted.insertId, conversation.id]);
	await queryUser(query, 'INSERT INTO message_statistics (room, total) VALUES (?, 1) ON DUPLICATE KEY UPDATE total = total + 1', [room]);
};

const main = async () => {
	await assertDatabaseConnection();
	await initDatabase();
	const password = await bcrypt.hash(PASSWORD, 10);
	await withTransaction(async query => {
		for (const user of USERS) {
			await queryUser(query,
				`INSERT INTO user (username, password, phone, avatar, name, salt, signature)
				 VALUES (?, ?, ?, ?, ?, '', ?) ON DUPLICATE KEY UPDATE avatar = VALUES(avatar), name = VALUES(name), signature = VALUES(signature)`,
				[user.username, password, user.phone, user.avatar, user.name, '喜欢番剧、手办和夏日祭。']
			);
		}
		const users = await queryUser<UserRow[]>(query, `SELECT id, username, name, avatar FROM user WHERE username IN (${USERS.map(() => '?').join(', ')})`, USERS.map(item => item.username));
		const byName = new Map(users.map(item => [item.username, item]));
		const hikari = byName.get('bocchi_hitori')!;
		const rin = byName.get('bocchi_nijika')!;
		const mio = byName.get('bocchi_ryo')!;
		const sora = byName.get('bocchi_kita')!;
		const directRoom = await ensureDirectRoom(query, hikari, rin);
		await ensureDirectRoom(query, hikari, mio);
		await ensureDirectRoom(query, hikari, sora);
		await ensureMessage(query, directRoom, 'private', rin.id, hikari.id, '凛，今晚一起补《星海回响》第八集吗？', 'anime-demo-direct-1');
		await ensureMessage(query, directRoom, 'private', hikari.id, rin.id, '当然！我还准备了樱花汽水和应援棒。', 'anime-demo-direct-2');

		const groupRoom = 'anime-summer-club-2026';
		let groups = await queryUser<IdRow[]>(query, 'SELECT id FROM group_chat WHERE room = ? LIMIT 1', [groupRoom]);
		if (!groups.length) {
			const created = await queryUser<WriteResult>(query, 'INSERT INTO group_chat (name, creator_id, avatar, announcement, room) VALUES (?, ?, ?, ?, ?)', [
				'夏日新番研究社', hikari.id, `${AVATAR_BASE}summer-anime-club`, '每周五 20:00 云同步追番，欢迎分享本命角色。', groupRoom
			]);
			groups = [{ id: created.insertId }];
		}
		const groupId = groups[0].id;
		for (const member of [hikari, rin, mio, sora]) {
			await queryUser(query, 'INSERT IGNORE INTO group_members (group_id, user_id, nickname) VALUES (?, ?, ?)', [groupId, member.id, member.name]);
		}
		await ensureMessage(query, groupRoom, 'group', groupId, mio.id, '本周新番投票：魔法少女、机甲远征，还是校园乐队？', 'anime-demo-group-1');
		await ensureMessage(query, groupRoom, 'group', groupId, sora.id, '我投校园乐队！OP 的吉他前奏太上头了。', 'anime-demo-group-2');
		await ensureMessage(query, groupRoom, 'group', groupId, hikari.id, '周五见，记得带上你最喜欢的角色表情包～', 'anime-demo-group-3');
	});
	console.log(`Anime demo data ready. Password for all accounts: ${PASSWORD}`);
	console.log(`Accounts: ${USERS.map(user => user.username).join(', ')}`);
};

main()
	.catch(error => {
		console.error('[seed:anime-demo] failed:', error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	.finally(() => db.end());
