import { Room, RoomEvent, Track, type LocalTrack, type RemoteTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { endCall, requestJoinCredentials, type CallType } from '@/components/AudioModal/livekit-api';

export interface LiveKitParticipant { identity: string; audioTrack?: RemoteTrack; videoTrack?: RemoteTrack }
export type MediaMode = 'audio' | 'video';

const readParticipants = (room: Room): LiveKitParticipant[] => Array.from(room.remoteParticipants.values()).slice(0, 19).map(participant => ({
	identity: participant.identity,
	audioTrack: participant.getTrackPublication(Track.Source.Microphone)?.track as RemoteTrack | undefined,
	videoTrack: participant.getTrackPublication(Track.Source.Camera)?.track as RemoteTrack | undefined
}));

/** Owns the LiveKit room and guarantees tracks/connection are released exactly once. */
export const useLiveKitCall = (roomId: string, type: CallType, mediaMode: MediaMode) => {
	const roomRef = useRef<Room | null>(null);
	const [participants, setParticipants] = useState<LiveKitParticipant[]>([]);
	const [localVideoTrack, setLocalVideoTrack] = useState<LocalTrack | undefined>();
	const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'failed'>('idle');
	const syncParticipants = useCallback(() => {
		if (roomRef.current) setParticipants(readParticipants(roomRef.current));
	}, []);

	const join = useCallback(async () => {
		if (roomRef.current) return;
		setConnectionState('connecting');
		try {
			const credentials = await requestJoinCredentials(roomId, type);
			const room = new Room({ adaptiveStream: true, dynacast: true });
			roomRef.current = room;
			room.on(RoomEvent.ParticipantConnected, syncParticipants);
			room.on(RoomEvent.ParticipantDisconnected, syncParticipants);
			room.on(RoomEvent.TrackSubscribed, syncParticipants);
			room.on(RoomEvent.TrackUnsubscribed, syncParticipants);
			room.on(RoomEvent.Disconnected, () => { setParticipants([]); setConnectionState('idle'); roomRef.current = null; });
			await room.connect(credentials.serverUrl, credentials.token);
			await room.localParticipant.setMicrophoneEnabled(true);
			if (mediaMode === 'video') {
				await room.localParticipant.setCameraEnabled(true);
				setLocalVideoTrack(room.localParticipant.getTrackPublication(Track.Source.Camera)?.track);
			}
			syncParticipants();
			setConnectionState('connected');
		} catch (error) {
			roomRef.current?.disconnect();
			roomRef.current = null;
			setConnectionState('failed');
			throw error;
		}
	}, [mediaMode, roomId, syncParticipants, type]);

	const leave = useCallback(async () => {
		const room = roomRef.current;
		roomRef.current = null;
		room?.disconnect();
		setParticipants([]);
		setLocalVideoTrack(undefined);
		setConnectionState('idle');
		try { await endCall(); } catch { /* local cleanup must not depend on the API */ }
	}, []);
	useEffect(() => () => { void leave(); }, [leave]);
	return { join, leave, participants, localVideoTrack, connectionState };
};
