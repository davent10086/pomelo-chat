import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Empty, Select, Spin, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { IMessageListItem } from '@/components/ChatTool/type';
import type { IMessageItem } from '@/components/MessageShow/type';
import { getChatList } from '@/pages/chat/api';
import Request from '@/utils/request';
import { downloadFile, getFileIcons, getFileName } from '@/utils/File';
import { getAuthorizedMediaURL } from '@/utils/media-url';
import styles from './index.module.less';

type AttachmentPage = { messages: IMessageItem[]; hasMore: boolean; nextBeforeId?: number };
export default function ChatFiles() {
	const [rooms, setRooms] = useState<IMessageListItem[]>([]);
	const [room, setRoom] = useState('');
	const [kind, setKind] = useState<'file' | 'image' | 'video'>('file');
	const [rows, setRows] = useState<IMessageItem[]>([]);
	const [cursor, setCursor] = useState<number>();
	const [next, setNext] = useState<number>();
	const [more, setMore] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [revision, setRevision] = useState(0);
	const [roomRevision, setRoomRevision] = useState(0);
	const [roomsLoading, setRoomsLoading] = useState(true);
	const downloading = useRef(new Set<string>());
	useEffect(() => {
		const controller = new AbortController();
		setRoomsLoading(true); setError('');
		void getChatList(controller.signal).then(result => {
			if (controller.signal.aborted) return;
			if (result.code !== 200) throw new Error();
			const items = result.data.filter(item => !item.room.startsWith('ai_'));
			setRooms(items); setRoom(previous => items.some(item => item.room === previous) ? previous : items[0]?.room || '');
		}).catch(() => { if (!controller.signal.aborted) setError('无法加载会话，请刷新重试'); })
			.finally(() => { if (!controller.signal.aborted) setRoomsLoading(false); });
		return () => controller.abort();
	}, [roomRevision]);
	const selected = rooms.find(item => item.room === room);
	const type = selected?.receiver_username ? 'private' : 'group';
	useEffect(() => {
		if (!room) { setRows([]); setLoading(false); return; }
		const controller = new AbortController();
		setLoading(true); setError('');
		if (!cursor) setRows([]);
		void Request.get<AttachmentPage>('message/search', {
			params: { room, type, mediaType: kind, beforeId: cursor, limit: 30 }, signal: controller.signal
		}).then(result => {
			if (controller.signal.aborted) return;
			if (result.data.code !== 200) throw new Error();
			const data = result.data.data;
			setRows(previous => cursor ? [...new Map([...previous, ...data.messages].map(item => [item.id, item])).values()] : data.messages);
			setMore(data.hasMore); setNext(data.nextBeforeId);
		}).catch(() => { if (!controller.signal.aborted) setError('附件加载失败，会话权限可能已变更，请重试'); })
			.finally(() => { if (!controller.signal.aborted) setLoading(false); });
		return () => controller.abort();
	}, [room, type, kind, cursor, revision]);
	const download = async (item: IMessageItem) => {
		if (downloading.current.has(item.content)) return;
		downloading.current.add(item.content);
		try {
			if (window.pomeloDesktop) await window.pomeloDesktop.downloadFile(item.content, item.file_name || undefined);
			else await downloadFile(getAuthorizedMediaURL(item.content), item.file_name || undefined);
		} catch { message.error('下载失败，请检查连接和会话权限后重试'); }
		finally { downloading.current.delete(item.content); }
	};
	return <section className={styles.filesPage} aria-label="聊天文件">
		<header><div><h1>聊天文件</h1><p>按会话查找和下载文件、图片与视频。</p></div>
			<Button aria-label="刷新聊天文件" icon={<ReloadOutlined />} disabled={loading || roomsLoading}
				onClick={() => { setCursor(undefined); setRevision(value => value + 1); setRoomRevision(value => value + 1); }}>刷新</Button></header>
		<div className={styles.filters}>
			<Select aria-label="文件所属会话" placeholder="选择会话" value={room || undefined} loading={roomsLoading}
				showSearch optionFilterProp="label" options={rooms.map(item => ({ value: item.room, label: item.name }))}
				onChange={value => { setRoom(value); setCursor(undefined); }} />
			<Select aria-label="附件类型" value={kind} options={[{ value: 'file', label: '文件' }, { value: 'image', label: '图片' }, { value: 'video', label: '视频' }]}
				onChange={value => { setKind(value); setCursor(undefined); }} />
		</div>
		<div className={styles.fileList} aria-busy={loading || roomsLoading}>
			{error && <div role="alert">{error} <Button size="small" onClick={() => { setRoomRevision(value => value + 1); setRevision(value => value + 1); }}>重试</Button></div>}
			{!error && !loading && !roomsLoading && !rows.length && <Empty description={room ? '该会话暂无此类附件' : '暂无聊天会话'} />}
			{rows.map(item => <article key={item.id} className={styles.fileRow}>
				<img src={getFileIcons(item.content)} alt="" width={36} height={42} />
				<div className={styles.fileInfo}><strong title={item.file_name || getFileName(item.content)}>{item.file_name || getFileName(item.content)}</strong>
					<span>{item.file_size} · {item.sender_name || '会话成员'} · {String(item.created_at)}</span></div>
				<Button aria-label={`下载 ${item.file_name || getFileName(item.content)}`} icon={<DownloadOutlined />} onClick={() => void download(item)}>下载</Button>
			</article>)}
			{(loading || roomsLoading) && <div role="status" className={styles.loading}><Spin /> 正在加载…</div>}
			{more && !error && <Button disabled={loading} onClick={() => setCursor(next)}>加载更多附件</Button>}
		</div>
	</section>;
}
