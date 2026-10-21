import { Room, RoomEvent, Track, type LocalTrack, type RemoteTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { requestJoinCredentials, type CallType } from '@/components/AudioModal/livekit-api';

export interface LiveKitParticipant {
	identity: string;
	audioTrack?: RemoteTrack;
	videoTrack?: RemoteTrack;
}
export type MediaMode = 'audio' | 'video';

const readParticipants = (room: Room): LiveKitParticipant[] =>
	Array.from(room.remoteParticipants.values())
		.slice(0, 19)
		.map(participant => ({
			identity: participant.identity,
			audioTrack: participant.getTrackPublication(Track.Source.Microphone)?.track as
				RemoteTrack | undefined,
			videoTrack: participant.getTrackPublication(Track.Source.Camera)?.track as
				RemoteTrack | undefined
		}));

/** Owns the LiveKit room and guarantees tracks/connection are released exactly once. */
export const useLiveKitCall = (roomId: string, type: CallType, mediaMode: MediaMode) => {
	const roomRef = useRef<Room | null>(null);
	const joining = useRef(false);
	const generation = useRef(0);
	const [participants, setParticipants] = useState<LiveKitParticipant[]>([]);
	const [localVideoTrack, setLocalVideoTrack] = useState<LocalTrack | undefined>();
	const [connectionState, setConnectionState] = useState<
		'idle' | 'connecting' | 'connected' | 'failed'
	>('idle');
	const syncParticipants = useCallback(() => {
		if (roomRef.current) setParticipants(readParticipants(roomRef.current));
	}, []);

	const join = useCallback(
		async (callId: string) => {
			if (roomRef.current || joining.current) return;
			joining.current = true;
			const epoch = generation.current;
			setConnectionState('connecting');
			let ownedRoom: Room | undefined;
			try {
				const credentials = await requestJoinCredentials(roomId, type, callId);
				if (epoch !== generation.current) return;
				const room = new Room({ adaptiveStream: true, dynacast: true });
				ownedRoom = room;
				roomRef.current = room;
				room.on(RoomEvent.ParticipantConnected, syncParticipants);
				room.on(RoomEvent.ParticipantDisconnected, syncParticipants);
				room.on(RoomEvent.TrackSubscribed, syncParticipants);
				room.on(RoomEvent.TrackUnsubscribed, syncParticipants);
				room.on(RoomEvent.Disconnected, () => {
					if (roomRef.current !== room) return;
					setParticipants([]);
					setLocalVideoTrack(undefined);
					setConnectionState('idle');
					roomRef.current = null;
					window.dispatchEvent(new CustomEvent('pomelo-call-disconnected', { detail: { callId } }));
				});
				await room.connect(credentials.serverUrl, credentials.token);
				if (epoch !== generation.current) {
					await room.disconnect();
					return;
				}
				await room.localParticipant.setMicrophoneEnabled(true);
				if (epoch !== generation.current) {
					await room.disconnect();
					return;
				}
				if (mediaMode === 'video') {
					await room.localParticipant.setCameraEnabled(true);
					if (epoch !== generation.current) {
						await room.disconnect();
						return;
					}
					setLocalVideoTrack(room.localParticipant.getTrackPublication(Track.Source.Camera)?.track);
				}
				syncParticipants();
				setConnectionState('connected');
			} catch (error) {
				if (roomRef.current === ownedRoom) roomRef.current = null;
				await ownedRoom?.disconnect();
				// A newer room generation intentionally cancelled this attempt.
				if (epoch !== generation.current) return;
				setConnectionState('failed');
				throw error;
			} finally {
				if (epoch === generation.current) joining.current = false;
			}
		},
		[mediaMode, roomId, syncParticipants, type]
	);

	const leave = useCallback(async () => {
		generation.current++;
		joining.current = false;
		const room = roomRef.current;
		roomRef.current = null;
		await room?.disconnect();
		setParticipants([]);
		setLocalVideoTrack(undefined);
		setConnectionState('idle');
	}, []);
	useEffect(
		() => () => {
			void leave();
		},
		[leave]
	);
	return { join, leave, participants, localVideoTrack, connectionState };
};
