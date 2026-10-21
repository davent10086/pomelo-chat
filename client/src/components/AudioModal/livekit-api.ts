import Request from '@/utils/request';

export type CallType = 'private' | 'group';
export interface JoinCredentials { serverUrl: string; roomName: string; token: string; identity: string; expiresIn: number; mediaGeneration?: number }

export const requestJoinCredentials = async (room: string, type: CallType, callId: string): Promise<JoinCredentials> => {
	const response = await Request.post<{ room: string; type: CallType; callId: string }, JoinCredentials>('rtc/join-token', { room, type, callId });
	return response.data.data;
};

export const inviteToCall = (room: string, type: CallType, mode: string) =>
	Request.post<{room: string; type: CallType; mode: string}, {callId: string; expiresAt: number}>('rtc/invite', { room, type, mode });

export const endCall = (callId: string) => Request.post('rtc/end', {callId});
export const acceptCall = (callId: string) => Request.post('rtc/accept', {callId});
