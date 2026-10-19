import { assertDatabaseConnection } from './database';
import { better_chat } from './redis';

/** Bound the probe; health responses never expose dependency credentials or errors. */
export const backendReady = async (): Promise<boolean> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.all([assertDatabaseConnection(), better_chat.ping()]).then(
				() => true,
				() => false
			),
			new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(false), 1500);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};
