import Request from '@/utils/request';

export type CallType = 'private' | 'group';
export interface JoinCredentials { serverUrl: string; roomName: string; token: string; identity: string; expiresIn: number }

export const requestJoinCredentials = async (room: string, type: CallType): Promise<JoinCredentials> => {
	const response = await Request.post<{ room: string; type: CallType }, JoinCredentials>('rtc/join-token', { room, type });
	return response.data.data;
};

export const inviteToCall = (room: string, type: CallType, mode: string) =>
	Request.post('rtc/invite', { room, type, mode });

export const endCall = () => Request.post('rtc/end');
