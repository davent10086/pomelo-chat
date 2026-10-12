import {
	better_chat,
	startSessionSubscription,
	stopSessionSubscription
} from './utils/authenticate';
import { startNotificationDelivery, stopNotificationDelivery } from './utils/notification';
import { stopNotificationConnections } from './utils/notification-connections';
import { startSessionChecks, stopSessionChecks } from './utils/socket-session';
import { startCallTimeouts, stopCallTimeouts } from './service/rtc/calls';
import { startMessageDelivery, stopMessageDelivery } from './service/message';
import { externalMcpManager } from './service/assistant/tools/external-mcp';

let starting: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
let running = false;

/** Entry points own all subscriptions and periodic work; imports open no sockets. */
export const startBackgroundServices = async () => {
	if (stopping) await stopping;
	if (running) return;
	if (starting) return starting;
	starting = (async () => {
		try {
			if (better_chat.status === 'wait' || better_chat.status === 'end')
				await better_chat.connect();
			await startSessionSubscription();
			await startNotificationDelivery();
			startSessionChecks();
			startCallTimeouts();
			await startMessageDelivery();
			running = true;
		} catch (error) {
			await dispose();
			throw error;
		}
	})();
	try {
		await starting;
	} finally {
		starting = undefined;
	}
};
const dispose = async () => {
	const workers = await Promise.allSettled([stopCallTimeouts(), stopMessageDelivery()]);
	const sockets = await Promise.allSettled([stopNotificationConnections(), stopSessionChecks()]);
	stopNotificationDelivery();
	stopSessionSubscription();
	running = false;
	await externalMcpManager.close();
	const failures = [...workers, ...sockets].filter(
		(result): result is PromiseRejectedResult => result.status === 'rejected'
	);
	if (failures.length)
		throw new Error(
			`Background cleanup failed: ${failures.map(result => String(result.reason)).join('; ')}`
		);
};
export const stopBackgroundServices = async () => {
	if (stopping) return stopping;
	stopping = (async () => {
		if (starting) await starting.catch(() => undefined);
		await dispose();
	})();
	try {
		await stopping;
	} finally {
		stopping = undefined;
	}
};
