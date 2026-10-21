import { useCallback, useEffect, useRef, useState } from 'react';
import { acceptCall, endCall, inviteToCall } from '@/components/AudioModal/livekit-api';
import { CallStatus, type ICallModalProps } from '@/components/AudioModal/type';
import { useLiveKitCall, type MediaMode } from './useLiveKitCall';
import useShowMessage from './useShowMessage';

/** One mounted modal owns one call; views only choose audio/video presentation. */
export const useCallController = (
	{ callInfo, status, type, handleModal }: Omit<ICallModalProps, 'openmodal'>,
	mode: MediaMode
) => {
	const [session] = useState(() => ({ room: callInfo.room, type, status }));
	const media = useLiveKitCall(session.room, session.type, mode);
	const { join, leave } = media;
	const showMessage = useShowMessage();
	const close = useRef(handleModal);
	close.current = handleModal;
	const callId = useRef(callInfo.callId);
	const pending = useRef(false);
	const disposed = useRef(false);
	const accepted = useRef(status === CallStatus.CALLING);
	const endedIds = useRef(new Set<string>());
	const mediaGeneration = useRef(0);
	const reconnecting = useRef(false);
	const needsReconnect = useRef(false);
	const [callStatus, setCallStatus] = useState(status);
	const [duration, setDuration] = useState(0);

	const endOnce = useCallback(async (id?: string) => {
		if (!id || endedIds.current.has(id)) return;
		endedIds.current.add(id);
		await endCall(id).catch(() => undefined);
	}, []);
	const release = useCallback(async () => {
		await Promise.all([endOnce(callId.current), leave().catch(() => undefined)]);
	}, [endOnce, leave]);
	const hangup = useCallback(async () => {
		if (disposed.current) return;
		disposed.current = true;
		close.current(false);
		await release();
	}, [release]);
	const reconnectMedia = useCallback(async () => {
		needsReconnect.current = true;
		if (reconnecting.current || disposed.current) return;
		reconnecting.current = true;
		try {
			while (needsReconnect.current && !disposed.current) {
				needsReconnect.current = false;
				await leave();
				if (!disposed.current && callId.current) await join(callId.current);
			}
		} catch {
			if (!disposed.current) showMessage('error', '通话连接已结束，请重新发起');
			await hangup();
		} finally { reconnecting.current = false; }
	}, [hangup, join, leave, showMessage]);
	const start = useCallback(async () => {
		if (pending.current || disposed.current || accepted.current) return;
		pending.current = true;
		try {
			if (session.status === CallStatus.INITIATE) {
				const response = await inviteToCall(session.room, session.type, `${session.type}_${mode}`);
				callId.current = response.data.data.callId;
			} else {
				if (!callId.current) throw new Error('Missing call id');
				await acceptCall(callId.current);
				accepted.current = true;
			}
			if (disposed.current) {
				await endOnce(callId.current);
				return;
			}
			await join(callId.current!);
			if (!disposed.current && session.status !== CallStatus.INITIATE)
				setCallStatus(CallStatus.CALLING);
		} catch {
			if (!disposed.current) showMessage('error', '无法连接通话，请检查服务和设备权限');
			await hangup();
		} finally {
			pending.current = false;
		}
	}, [session, mode, join, endOnce, showMessage, hangup]);

	useEffect(() => {
		const onState = (event: Event) => {
			const state = (
				event as CustomEvent<{ callId: string; status: string; memberStatus?: string; mediaGeneration?: number }>
			).detail;
			if (state.callId !== callId.current || disposed.current) return;
			if (state.status === 'ended' || state.memberStatus === 'left') void hangup();
			else if (state.status === 'active' && state.memberStatus === 'joined') {
				accepted.current = true;
				setCallStatus(CallStatus.CALLING);
				if ((state.mediaGeneration || 0) > mediaGeneration.current) {
					mediaGeneration.current = state.mediaGeneration || 0;
					void reconnectMedia();
				}
			}
		};
		const onDisconnected = (event: Event) => {
			if ((event as CustomEvent<{ callId: string }>).detail.callId === callId.current) {
				if (session.type === 'group') void reconnectMedia();
				else void hangup();
			}
		};
		window.addEventListener('pomelo-call-state', onState);
		window.addEventListener('pomelo-call-disconnected', onDisconnected);
		const timeout = setTimeout(() => {
			if (!accepted.current) void hangup();
		}, 45000);
		if (session.status === CallStatus.INITIATE) void start();
		return () => {
			disposed.current = true;
			clearTimeout(timeout);
			window.removeEventListener('pomelo-call-state', onState);
			window.removeEventListener('pomelo-call-disconnected', onDisconnected);
			void release();
		};
	}, [session.status, session.type, start, hangup, release, reconnectMedia]);
	useEffect(() => {
		if (callStatus !== CallStatus.CALLING) return;
		const timer = setInterval(() => setDuration(value => value + 1), 1000);
		return () => clearInterval(timer);
	}, [callStatus]);
	return { ...media, callStatus, duration, start, hangup };
};
