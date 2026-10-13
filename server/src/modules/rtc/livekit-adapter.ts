import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { Actor } from '../../shared/actor';
type ChatType = 'private' | 'group';
const MAX_PARTICIPANTS = 20;
const TOKEN_TTL_SECONDS = 10 * 60;
const roomName = (type: ChatType, room: string) => `pomelo-${type}-${room}`;
const liveKitConfig = () => ({
	apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
	apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
	serverUrl: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
	httpUrl: process.env.LIVEKIT_HTTP_URL || 'http://127.0.0.1:7880'
});

export const issueJoinToken = async (
	actor: Actor,
	room: string,
	type: ChatType,
	callId: string
) => {
	const config = liveKitConfig();
	const liveKitRoom = roomName(type, `${room}-${callId}`);
	const service = new RoomServiceClient(config.httpUrl, config.apiKey, config.apiSecret);
	try {
		await service.createRoom({
			name: liveKitRoom,
			maxParticipants: MAX_PARTICIPANTS,
			emptyTimeout: 60,
			departureTimeout: 30
		});
	} catch (error) {
		if (!(error instanceof Error) || !/already exists/i.test(error.message)) throw error;
	}

	const token = new AccessToken(config.apiKey, config.apiSecret, {
		identity: actor.username,
		ttl: TOKEN_TTL_SECONDS,
		name: actor.name || actor.username
	});
	token.addGrant({
		roomJoin: true,
		room: liveKitRoom,
		canPublish: true,
		canSubscribe: true,
		canPublishData: false
	});
	return {
		serverUrl: config.serverUrl,
		roomName: liveKitRoom,
		token: await token.toJwt(),
		identity: actor.username,
		expiresIn: TOKEN_TTL_SECONDS
	};
};
