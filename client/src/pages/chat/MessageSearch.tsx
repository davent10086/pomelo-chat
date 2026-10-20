import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select } from 'antd';
import request from '@/utils/request';
import styles from './index.module.less';
import type { IMessageItem } from '@/components/MessageShow/type';
import type { MessageType } from '@/components/ChatTool/type';

export default function MessageSearch({
	room,
	type,
	messages,
	onLocate,
	onClose
}: {
	room: string;
	type: 'private' | 'group';
	messages: IMessageItem[];
	onLocate: (id: number) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState('');
	const [since, setSince] = useState('');
	const [until, setUntil] = useState('');
	const [senderId, setSenderId] = useState<number>();
	const [mediaType, setMediaType] = useState<MessageType>();
	const [results, setResults] = useState<IMessageItem[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const revision = useRef(0);
	const abort = useRef<AbortController>();
	const senders = [
		...new Map(
			[...messages, ...results].map(item => [
				item.sender_id,
				{ value: item.sender_id, label: item.sender_name || `用户 ${item.sender_id}` }
			])
		).values()
	];
	const filters = JSON.stringify({
		room,
		type,
		query: query.trim(),
		since,
		until,
		senderId,
		mediaType
	});
	const invalidate = useCallback(() => { revision.current++; abort.current?.abort(); }, []);
	useEffect(() => {
		revision.current++;
		abort.current?.abort();
		setResults([]);
		setHasMore(false);
		setError('');
		setLoading(false);
		return invalidate;
	}, [filters, invalidate]);
	const search = async (more = false) => {
		abort.current?.abort();
		abort.current = new AbortController();
		const version = ++revision.current;
		if (query.trim() && mediaType && mediaType !== 'text') {
			setError('搜索附件类型时请清除正文关键词');
			return;
		}
		if (since && until && since > until) {
			setError('开始日期不能晚于结束日期');
			return;
		}
		setLoading(true);
		setError('');
		try {
			const res = await request.get<{ messages: IMessageItem[]; hasMore: boolean }>(
				'/message/search',
				{
					params: {
						...JSON.parse(filters),
						since: since || undefined,
						until: until || undefined,
						limit: 20,
						beforeId: more ? results.at(-1)?.id : undefined
					},
					signal: abort.current.signal
				}
			);
			if (version !== revision.current) return;
			if (res.data.code !== 200) throw new Error('搜索失败');
			setResults(previous =>
				more ? [...previous, ...res.data.data.messages] : res.data.data.messages
			);
			setHasMore(res.data.data.hasMore);
			if (!res.data.data.messages.length && !more) setError('没有找到符合条件的消息');
		} catch {
			if (version === revision.current) setError('搜索失败，请检查条件或重试');
		} finally {
			if (version === revision.current) setLoading(false);
		}
	};
	return (
		<aside aria-label="聊天记录搜索" className={styles.messageSearch}>
			<Button onClick={onClose}>关闭搜索</Button>
			<h3>搜索聊天记录</h3>
			<Input
				aria-label="聊天记录关键词"
				placeholder="正文关键词"
				maxLength={100}
				value={query}
				onChange={event => setQuery(event.target.value)}
				onPressEnter={() => void search()}
			/>
			<label>
				开始日期
				<input
					aria-label="开始日期"
					type="date"
					value={since}
					onChange={event => setSince(event.target.value)}
				/>
			</label>
			<label>
				结束日期
				<input
					aria-label="结束日期"
					type="date"
					value={until}
					onChange={event => setUntil(event.target.value)}
				/>
			</label>
			<Select
				aria-label="发送者"
				placeholder="全部发送者"
				style={{ width: '100%', marginTop: 8 }}
				allowClear
				value={senderId}
				onChange={setSenderId}
				options={senders}
			/>
			<Input
				aria-label="发送者 ID"
				placeholder="也可输入发送者 ID"
				type="number"
				min={1}
				value={senderId ?? ''}
				onChange={event => setSenderId(event.target.value ? Number(event.target.value) : undefined)}
			/>
			<Select
				aria-label="消息类型"
				placeholder="全部类型"
				style={{ width: '100%', marginTop: 8 }}
				allowClear
				value={mediaType}
				onChange={setMediaType}
				options={[
					{ value: 'text', label: '文字' },
					{ value: 'image', label: '图片' },
					{ value: 'video', label: '视频' },
					{ value: 'file', label: '文件' }
				]}
			/>
			<Button
				aria-label="搜索"
				type="primary"
				onClick={() => void search()}
				loading={loading}
				style={{ marginTop: 8 }}
			>
				搜索
			</Button>
			{error && <p role="status">{error}</p>}
			{results.map(item => (
				<button
					key={item.id}
					type="button"
					onClick={event => {
						onLocate(item.id!);
						const body = event.currentTarget.closest('aside')?.parentElement;
						if (body && body.clientWidth <= 840) onClose();
					}}
					style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 12, padding: 8 }}
				>
					<div>
						{item.sender_name || `用户 ${item.sender_id}`} · {String(item.created_at)}
					</div>
					<div>
						{item.type === 'text'
							? item.content.slice(0, 240)
							: `[${item.type}] ${item.content.split('/').at(-1)}`}
					</div>
				</button>
			))}
			{hasMore && (
				<Button loading={loading} onClick={() => void search(true)}>
					更多结果
				</Button>
			)}
		</aside>
	);
}
