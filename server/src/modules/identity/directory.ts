import * as repository from './repository';

export interface PublicUserProfile {
	id: number;
	username: string;
	name: string | null;
	avatar: string | null;
}

export const getPublicUserProfile = async (
	userId: number | string
): Promise<PublicUserProfile | null> =>
	(await repository.findPublicProfile<PublicUserProfile[]>([userId]))[0] || null;

export const getUsernameById = async (userId: number | string): Promise<string | undefined> =>
	(await repository.findUsernameById<Array<{ username: string }>>([userId]))[0]?.username;
