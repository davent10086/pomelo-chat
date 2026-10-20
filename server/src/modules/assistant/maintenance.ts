import { pruneExpiredActions, pruneAuditLogs } from './repository';
let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<void> | undefined;
export const startAssistantMaintenance = () => {
	if (timer) return;
	timer = setInterval(() => {
		if (!pending) pending = Promise.all([pruneExpiredActions(), pruneAuditLogs()]).then(() => undefined).catch(error => console.error('[assistant] retention:', error)).finally(() => { pending = undefined; });
	}, 3600000);
	timer.unref();
};
export const stopAssistantMaintenance = async () => { if (timer) clearInterval(timer); timer = undefined; await pending; };
