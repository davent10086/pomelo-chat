import {
	CloseCircleOutlined,
	CopyOutlined,
	DeleteOutlined,
	LoadingOutlined,
	ReloadOutlined,
	MoreOutlined
} from '@ant-design/icons';
import { Button, Dropdown, Image, Modal, message as antdMessage } from 'antd';
import { useEffect, useState } from 'react';

import styles from './index.module.less';
import { IChatContentProps, IMessageShowProps, IMediaInfo } from './type';

import { ChatImage, LoadErrorImage } from '@/assets/images';
import ImageLoad from '@/components/ImageLoad';
import {
	downloadFile,
	getFileIcons,
	getFileName,
	getMediaShowSize,
	getMediaSize,
	urlExists
} from '@/utils/File';
import { getAuthorizedMediaURL, useAuthorizedMediaURL } from '@/utils/media-url';
import { userStorage } from '@/utils/storage';
import { formatChatContentTime } from '@/utils/time';

const ChatContentPocket = () => (
	<div className={`${styles.content_delete} ${styles.content_file}`}>
		<img src={LoadErrorImage.FILE_DELETE} draggable="false" alt="文件已过期" />
		<span>文件已过期或被清理</span>
	</div>
);

const DeliveryChecks = ({ read }: { read: boolean }) => (
	<svg
		width={read ? 22 : 16}
		height="16"
		viewBox={read ? '0 0 22 16' : '0 0 16 16'}
		fill="none"
		stroke="currentColor"
		strokeWidth="1.8"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M2 8l4 4 8-8" />
		{read && <path d="M10 12l10-8" />}
	</svg>
);

const ChatContent = (props: IChatContentProps): JSX.Element | null => {
	const { messageType, messageContent, fileSize, fileName } = props;
	const [curMediaInfo, setCurMediaInfo] = useState<IMediaInfo | null>(null);
	const [isVideoPlay, setIsVideoPlay] = useState(false);
	const [isFileExist, setIsFileExist] = useState(true);
	const mediaURL = useAuthorizedMediaURL(messageType === 'text' ? '' : messageContent);

	useEffect(() => {
		let active = true;
		setIsFileExist(true);
		setCurMediaInfo(null);
		if (messageType !== 'text' && mediaURL) {
			urlExists(mediaURL).then(res => {
				if (active) setIsFileExist(res);
			});
		}
		if (mediaURL && (messageType === 'image' || messageType === 'video')) {
			getMediaSize(mediaURL, messageType)
				.then(size => { if (active) setCurMediaInfo({ type: messageType, url: mediaURL, size }); })
				.catch(() => undefined);
		}
		return () => { active = false; };
	}, [messageType, messageContent, mediaURL]);

	if (!isFileExist) return <ChatContentPocket />;

	switch (messageType) {
		case 'text':
			return <div className={styles.content_text}>{messageContent}</div>;
		case 'image':
			return curMediaInfo ? (
				<Image
					width={getMediaShowSize(curMediaInfo.size, 'image').width}
					src={curMediaInfo.url}
					rootClassName="content_image"
				/>
			) : (
				<div className={styles.content_media_placeholder} />
			);
		case 'video':
			return curMediaInfo ? (
				<div className={styles.content_video}>
					<video
						src={mediaURL}
						muted
						style={{ width: getMediaShowSize(curMediaInfo.size, 'video').width }}
					/>
					<button
						type="button"
						className={styles.play_button}
						onClick={() => setIsVideoPlay(true)}
						aria-label="播放视频"
					>
						<img src={ChatImage.PLAY} alt="" draggable="false" />
					</button>
					<Modal
						open={isVideoPlay}
						footer={null}
						title="视频"
						onCancel={() => setIsVideoPlay(false)}
						destroyOnClose
						width={800}
					>
						<video
							src={mediaURL}
							muted
							controls
							autoPlay
							width={750}
						/>
					</Modal>
				</div>
			) : (
				<div className={styles.content_media_placeholder} />
			);
		case 'file':
			return (
				<button
					type="button"
					className={styles.content_file}
					onClick={() => {
						if (window.pomeloDesktop) void window.pomeloDesktop.downloadFile(messageContent, fileName || undefined)
							.catch(() => antdMessage.error('下载失败，请重试'));
						else void getAuthorizedMediaURL(messageContent).then(url => downloadFile(url, fileName || undefined)).catch(() => antdMessage.error('下载失败，请重试'));
					}}
					aria-label={`下载文件 ${fileName || getFileName(messageContent)}`}
				>
					<div className={styles.content_file_name}>
						<span title={fileName || getFileName(messageContent)}>{fileName || getFileName(messageContent)}</span>
						{fileSize && <span>{fileSize}</span>}
					</div>
					<div className={styles.content_file_img}>
						<img src={getFileIcons(messageContent)} draggable="false" alt="文件" />
					</div>
				</button>
			);
		default:
			return null;
	}
};

const MessageShow = (props: IMessageShowProps) => {
	const { showTime, message, onRetry, onCancelRetry } = props;
	const user = userStorage.getItem();
	const { sender_id, content, avatar, type, file_size, created_at, status } = message;
	const [hidden, setHidden] = useState(false);
	const isSelf = sender_id === user.id;

	const statusMeta = (() => {
		if (sender_id === 0 && status === 'failed')
			return { text: `生成失败：${message.failureReason || '请重试'}`, icon: <CloseCircleOutlined /> };
		if (!isSelf) return null;
		if (status === 'failed')
			return { text: message.failureReason || '发送失败', icon: <CloseCircleOutlined /> };
		if (status === 'pending') return { text: '发送中', icon: <LoadingOutlined /> };
		return {
			text: message.read ? '对方已读' : '已发送',
			icon: <DeliveryChecks read={!!message.read} />
		};
	})();

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(content);
			antdMessage.success('已复制');
		} catch {
			antdMessage.error('复制失败');
		}
	};

	const actions = [
		{ key: 'copy', label: '复制', icon: <CopyOutlined aria-hidden="true" />, onClick: handleCopy },
		...(isSelf && status === 'failed' && onRetry
			? [
					{
						key: 'retry',
						label: '重新发送',
						icon: <ReloadOutlined aria-hidden="true" />,
						onClick: () => onRetry(message)
					}
				]
			: []),
		...(isSelf && (status === 'pending' || status === 'failed') && onCancelRetry
			? [{ key: 'cancel', label: '取消重试', onClick: () => onCancelRetry(message) }]
			: []),
		{
			key: 'hide',
			label: '本地隐藏',
			icon: <DeleteOutlined aria-hidden="true" />,
			danger: true,
			onClick: () => setHidden(true)
		}
	];
	const moreActions = (
		<div className={styles.message_actions}>
			<Dropdown trigger={['click']} menu={{ items: actions }}>
				<Button type="text" aria-label="消息更多操作" icon={<MoreOutlined />} />
			</Dropdown>
		</div>
	);

	if (hidden) return null;

	return (
		<>
			{showTime && created_at && (
				<div className={styles.chat_notice}>
					<span>{formatChatContentTime(created_at)}</span>
				</div>
			)}
			{isSelf ? (
				<div className={`${styles.self} ${styles.chat_item_content}`}>
					<div className={styles.message_bubble_wrap}>
						{moreActions}
						<ChatContent messageType={type} messageContent={content} fileSize={file_size} fileName={message.file_name || message.fileName} />
						{statusMeta && (
							<span
								role="status"
								title={statusMeta.text}
								aria-label={statusMeta.text}
								className={`${styles.message_status} ${status === 'failed' ? styles.status_failed : ''} ${message.read ? styles.status_read : ''}`}
							>
								{statusMeta.icon}
								{(status === 'pending' || status === 'failed') && statusMeta.text}
								{status === 'failed' && onRetry && (
									<Button size="small" onClick={() => onRetry(message)} aria-label="重新发送">
										重试
									</Button>
								)}
								{(status === 'pending' || status === 'failed') && onCancelRetry && (
									<Button size="small" onClick={() => onCancelRetry(message)}>
										取消重试
									</Button>
								)}
							</span>
						)}
					</div>
					<div className={styles.avatar}>
						<ImageLoad src={avatar} />
					</div>
				</div>
			) : (
				<div className={`${styles.other} ${styles.chat_item_content}`}>
					<div className={styles.avatar}>
						<ImageLoad src={avatar} />
					</div>
					<div className={styles.message_bubble_wrap}>
						{moreActions}
						<ChatContent messageType={type} messageContent={content} fileSize={file_size} fileName={message.file_name || message.fileName} />
						{statusMeta && <span role="status" aria-label={statusMeta.text} className={`${styles.message_status} ${styles.status_failed}`}>{statusMeta.icon}{statusMeta.text}</span>}
					</div>
				</div>
			)}
		</>
	);
};

export default MessageShow;
