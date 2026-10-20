import { better_chat } from '../../infrastructure/redis';
import { findPresenceObservers } from './repository';

/** Redis leases are authoritative across processes and expire after crashes. */
export const onlineUsernames = async (usernames: string[]): Promise<Set<string>> => {
	const names = [...new Set(usernames)];
	const online = new Set<string>();
	for (let offset = 0; offset < names.length; offset += 500) {
		const page = names.slice(offset, offset + 500);
		const leases = await better_chat.mget(...page.map(name => `presence:${name}`));
		page.forEach((name, index) => {
			if (leases[index]) online.add(name);
		});
	}
	return online;
};

export const presenceObservers = (username: string): Promise<Array<{ username: string }>> =>
	findPresenceObservers([username]);
