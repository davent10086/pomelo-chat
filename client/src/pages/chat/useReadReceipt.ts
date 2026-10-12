import { useEffect } from 'react';
import { markChatRead } from './api';
export function useReadReceipt(
	room: string | undefined,
	type: 'private' | 'group',
	sequence: number,
	enabled: boolean
) {
	useEffect(() => {
		if (!room || !enabled || sequence < 1) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const report = () => {
			clearTimeout(timer);
			if (document.visibilityState === 'visible')
				timer = setTimeout(() => {
					if (document.visibilityState === 'visible')
						void markChatRead({ room, type, roomSeq: sequence }).catch(() => undefined);
				}, 300);
		};
		report();
		document.addEventListener('visibilitychange', report);
		return () => {
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', report);
		};
	}, [room, type, sequence, enabled]);
}
