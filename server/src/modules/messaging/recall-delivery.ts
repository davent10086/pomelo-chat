import { pendingRecalls, completeRecall } from './repository';
import type { HistoryMessageRow } from './contracts';

let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;
export function startRecallDelivery(deliver: (row: HistoryMessageRow & { type: 'private' | 'group' }) => Promise<void>) {
	if (timer) return;
	const drain = () => {
		if (active) return;
		active = (async () => {
			for (const row of await pendingRecalls()) {
				await deliver(row);
				await completeRecall(row.id);
			}
		})().catch(error => console.error('[message] recall delivery will retry:', error instanceof Error ? error.message : String(error)))
			.finally(() => { active = undefined; });
	};
	timer = setInterval(drain, 1000); timer.unref(); drain();
}
export async function stopRecallDelivery() {
	if (timer) clearInterval(timer);
	timer = undefined;
	await active;
}
