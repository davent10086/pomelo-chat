import type { SqlQuery } from '../../shared/actor';
import type { NotificationData } from '../../shared/notification';
export interface SocialEffects {
	notifyUser: (data: NotificationData) => Promise<void>;
	isOnline: (username: string) => boolean;
	initializeGroupMessage: (
		query: SqlQuery,
		message: import('../messaging/contracts').InsertMessage
	) => Promise<number>;
}
