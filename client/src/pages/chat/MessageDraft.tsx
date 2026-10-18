import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import type { AgentAction, ActionStatus } from '@/hooks/useAiAssistant';
import type { IMessageListItem } from '@/components/ChatTool/type';
import useShowMessage from '@/hooks/useShowMessage';
import { RequestScope } from '@/utils/request-scope';
import { useAssistantActions } from './useAssistantActions';
import { ActionControls } from './ActionControls';
import styles from './index.module.less';

/** Selecting a room prepares a reviewable action; only explicit confirmation writes a message. */
export default function MessageDraft({
	draft,
	conversations
}: {
	draft: string;
	conversations: IMessageListItem[];
}) {
	const [request] = useState(() => new RequestScope());
	const showMessage = useShowMessage();
	const actions = useAssistantActions(request, showMessage);
	const [room, setRoom] = useState('');
	const [content, setContent] = useState(draft);
	const [action, setAction] = useState<AgentAction>();
	const [preparing, setPreparing] = useState(false);
	const prepareFlight = useRef(false);
	const review = useRef<HTMLDivElement>(null);
	useEffect(() => {
		review.current?.scrollIntoView({ block: 'nearest' });
	}, [action?.confirmationId, action?.status]);
	useEffect(() => {
		request.resume();
		return () => request.dispose();
	}, [request]);
	const locked = !!actions.pendingActionId || action?.status === 'executing';
	const change = () => {
		request.invalidate();
		prepareFlight.current = false;
		setPreparing(false);
		if (action?.confirmationId && (!action.status || action.status === 'pending')) {
			void request
				.post('/assistant/actions/cancel', { confirmationId: action.confirmationId })
				.catch(() => undefined);
		}
		setAction(undefined);
	};
	const prepare = async () => {
		const target = conversations.find(item => item.room === room);
		if (!target || !content.trim() || prepareFlight.current || locked) return;
		prepareFlight.current = true;
		setPreparing(true);
		const version = request.version;
		try {
			const response = await request.post<unknown, { action: AgentAction }>(
				'/assistant/actions/message-draft',
				{ room, chatType: target.receiver_username ? 'private' : 'group', content }
			);
			if (request.isCurrent(version))
				setAction({ ...response.data.data.action, status: 'pending' });
		} catch {
			if (request.isCurrent(version)) showMessage('error', '无法准备发送，请检查会话权限后重试');
		} finally {
			if (request.isCurrent(version)) {
				prepareFlight.current = false;
				setPreparing(false);
			}
		}
	};
	const apply = (status: ActionStatus) => {
		setAction(previous => (previous ? { ...previous, status: status.status } : previous));
	};
	const confirm = () => {
		if (!action) return;
		setAction({ ...action, status: 'executing' });
		void actions.run(action, 'confirm', apply, { success: '消息已发送' });
	};
	return (
		<section className={`${styles.agentSection} ${styles.messageDraftForm}`} aria-label="草稿发送">
			<div className={styles.agentTitle}>发送消息草稿</div>
			<p>请核对收件人。同名或姓名不确定时，请根据账号选择，不会自动发送。</p>
			<label>
				发送给
				<select
					aria-label="选择消息收件人"
					value={room}
					disabled={locked}
					onChange={event => {
						change();
						setRoom(event.target.value);
					}}
				>
					<option value="">请选择私聊或群聊</option>
					{conversations.map(item => (
						<option key={item.room} value={item.room}>
							{item.name}（
							{item.receiver_username
								? `私聊 · ${item.receiver_username}`
								: `群聊 · ${item.receiver_id}`}
							）
						</option>
					))}
				</select>
			</label>
			<label>
				消息正文
				<textarea
					aria-label="待发送消息正文"
					value={content}
					maxLength={10000}
					rows={4}
					disabled={locked}
					onChange={event => {
						change();
						setContent(event.target.value);
					}}
				/>
			</label>
			{!action && (
				<Button
					onClick={() => void prepare()}
					loading={preparing}
					disabled={!room || !content.trim() || preparing}
				>
					核对发送信息
				</Button>
			)}
			{action && (
				<div aria-label="发送确认信息" ref={review}>
					<p>
						收件人：{String(action.payload.name)}（
						{action.payload.chatType === 'private'
							? `私聊 · ${String(action.payload.username)}`
							: `群聊 · ${String(action.payload.receiverId)}`}
						）
					</p>
					<p style={{ whiteSpace: 'pre-wrap' }}>发送正文：{String(action.payload.content)}</p>
					<ActionControls
						status={action.status || 'pending'}
						busy={!!actions.pendingActionId}
						showStatus
						confirmLabel="确认发送"
						onConfirm={confirm}
						onCancel={() => void actions.run(action, 'cancel', apply)}
						onQuery={() => void actions.run(action, 'query', apply, { retry: true })}
					/>
				</div>
			)}
		</section>
	);
}
