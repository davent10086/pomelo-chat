import { useEffect, useRef, useState } from 'react';
import { HttpStatus } from '@/utils/constant';

const PAGE_SIZE = 30;

export const useSearchResults = <T>(
	load: (
		term: string,
		afterId: number,
		signal: AbortSignal
	) => Promise<{ code: number; data: T[] }>,
	idOf: (item: T) => number,
	onError: () => void
) => {
	const [items, setItems] = useState<T[]>([]);
	const [loading, setLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);
	const current = useRef({ term: '', afterId: 0, generation: 0, busy: false });
	const controller = useRef<AbortController>();
	useEffect(() => () => controller.current?.abort(), []);

	const clear = () => {
		controller.current?.abort();
		current.current = {
			term: '',
			afterId: 0,
			generation: current.current.generation + 1,
			busy: false
		};
		setItems([]);
		setHasMore(false);
		setLoading(false);
	};
	const search = async (term: string, append = false) => {
		if (append && current.current.busy) return;
		if (!append) clear();
		const text = term.trim();
		if (!text) return;
		const generation = ++current.current.generation;
		current.current.term = text;
		current.current.busy = true;
		const request = new AbortController();
		controller.current = request;
		setLoading(true);
		try {
			const result = await load(text, append ? current.current.afterId : 0, request.signal);
			if (generation !== current.current.generation || request.signal.aborted) return;
			if (result.code !== HttpStatus.SUCCESS || !Array.isArray(result.data))
				throw new Error('Search failed');
			setItems(previous => (append ? [...previous, ...result.data] : result.data));
			setHasMore(result.data.length === PAGE_SIZE);
			if (result.data.length) current.current.afterId = idOf(result.data[result.data.length - 1]);
		} catch {
			if (generation === current.current.generation && !request.signal.aborted) onError();
		} finally {
			if (generation === current.current.generation) {
				current.current.busy = false;
				setLoading(false);
			}
		}
	};
	return {
		items,
		loading,
		hasMore,
		clear,
		search,
		loadMore: () => search(current.current.term, true)
	};
};
