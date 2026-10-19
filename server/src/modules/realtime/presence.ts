import { listPresenceRecipients } from '../../read-models/realtime';
import { forEachConcurrent } from '../../shared/parallel';
import { NotificationUser } from './notification';

export const notifyPresenceContacts = async (username: string) => {
	const recipients = await listPresenceRecipients<Array<{ username: string }>>([username]);
	await forEachConcurrent(recipients, 16, receiver =>
		NotificationUser({ receiver_username: receiver.username, name: 'friendList' })
	);
};
