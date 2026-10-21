import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import type { Actor } from '../../shared/actor';
import type { CallState } from './calls';
type ChatType = 'private' | 'group';
const MAX_PARTICIPANTS = 20;
const TOKEN_TTL_SECONDS = 60;
const roomName = (type: ChatType, room: string) => `pomelo-${type}-${room}`;
const mediaRoomName = (type: ChatType, room: string, id: string, generation = 0) =>
	roomName(type, `${room}-${id}${generation ? `-g${generation}` : ''}`);
const liveKitConfig = () => ({
	apiKey: process.env.LIVEKIT_API_KEY || 'devkey',
	apiSecret: process.env.LIVEKIT_API_SECRET || 'secret',
	serverUrl: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
	httpUrl: process.env.LIVEKIT_HTTP_URL || 'http://127.0.0.1:7880'
});
const roomService = () => {
	const config = liveKitConfig();
	return new RoomServiceClient(config.httpUrl, config.apiKey, config.apiSecret, { requestTimeout: 5, failover: false });
};
const ignoreMissing = async (work: Promise<unknown>) => {
	try { await work; }
	catch (error) {
		if ((error as { code?: string }).code !== 'not_found') throw error;
	}
};

/** Enforce business departures on the SFU, even when clients never disconnect themselves. */
export const revokeCallMedia = async (state: CallState): Promise<void> => {
	const service = roomService();
	await ignoreMissing(service.deleteRoom(mediaRoomName(state.type, state.room, state.id, state.mediaGeneration)));
};

export const issueJoinToken = async (
	actor: Actor,
	room: string,
	type: ChatType,
	callId: string,
	mediaGeneration = 0
) => {
	const config = liveKitConfig();
	const liveKitRoom = mediaRoomName(type, room, callId, mediaGeneration);
	const service = roomService();
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
		expiresIn: TOKEN_TTL_SECONDS,
		mediaGeneration
	};
};
