import { CheckCircleOutlined, CloseCircleOutlined, CopyOutlined, DeleteOutlined, LoadingOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Image, Modal, Tooltip, message as antdMessage } from 'antd';
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
import { getAuthorizedMediaURL } from '@/utils/media-url';
import { userStorage } from '@/utils/storage';
import { formatChatContentTime } from '@/utils/time';

const ChatContentPocket = () => (
	<div className={`${styles.content_delete} ${styles.content_file}`}>
		<img src={LoadErrorImage.FILE_DELETE} draggable="false" alt="文件已过期" />
		<span>文件已过期或被清理</span>
	</div>
);

const ChatContent = (props: IChatContentProps): JSX.Element | null => {
	const { messageType, messageContent, fileSize } = props;
	const [curMediaInfo, setCurMediaInfo] = useState<IMediaInfo | null>(null);
	const [isVideoPlay, setIsVideoPlay] = useState(false);
	const [isFileExist, setIsFileExist] = useState(true);

	useEffect(() => {
		if (messageType !== 'text') {
			urlExists(getAuthorizedMediaURL(messageContent)).then(res => {
				if (!res) setIsFileExist(false);
			});
		}
		if (messageType === 'image' || messageType === 'video') {
			const mediaURL = getAuthorizedMediaURL(messageContent);
			getMediaSize(mediaURL, messageType)
				.then(size => setCurMediaInfo({ type: messageType, url: mediaURL, size }))
				.catch(() => undefined);
		}
	}, [messageType, messageContent]);

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
						src={getAuthorizedMediaURL(messageContent)}
						muted
						style={{ width: getMediaShowSize(curMediaInfo.size, 'video').width }}
					/>
					<button type="button" className={styles.play_button} onClick={() => setIsVideoPlay(true)} aria-label="播放视频">
						<img src={ChatImage.PLAY} alt="" draggable="false" />
					</button>
					<Modal open={isVideoPlay} footer={null} title="视频" onCancel={() => setIsVideoPlay(false)} destroyOnClose width={800}>
						<video src={getAuthorizedMediaURL(messageContent)} muted controls autoPlay width={750} />
					</Modal>
				</div>
			) : (
				<div className={styles.content_media_placeholder} />
			);
		case 'file':
			return (
				<button type="button" className={styles.content_file} onClick={() => downloadFile(getAuthorizedMediaURL(messageContent))} aria-label={`下载文件 ${getFileName(messageContent)} `}>
					<div className={styles.content_file_name}>
						<span>{getFileName(messageContent)}</span>
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
	const { showTime, message } = props;
	const user = userStorage.getItem();
	const { sender_id, content, avatar, type, file_size, created_at, status } = message;
	const [hidden, setHidden] = useState(false);
	const isSelf = sender_id === user.id;

	const statusMeta = (() => {
		if (!isSelf) return null;
		if (status === 'failed') return { text: '发送失败', icon: <CloseCircleOutlined /> };
		if (status === 'pending') return { text: '发送中', icon: <LoadingOutlined /> };
		return { text: '已发送', icon: <CheckCircleOutlined /> };
	})();

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(content);
			antdMessage.success('已复制');
		} catch {
			antdMessage.error('复制失败');
		}
	};

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
					{statusMeta && (
						<span className={`${styles.message_status} ${status === 'failed' ? styles.status_failed : ''}`}>
							{statusMeta.icon}{statusMeta.text}
						</span>
					)}
					<div className={styles.message_bubble_wrap}>
						<div className={styles.message_actions}>
							<Tooltip title="复制"><Button size="small" type="text" icon={<CopyOutlined />} onClick={handleCopy} /></Tooltip>
							{status === 'failed' && (
								<Tooltip title="重新发送">
									<Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => antdMessage.info('请在输入框中重新发送这条消息')} />
								</Tooltip>
							)}
							<Tooltip title="本地隐藏"><Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setHidden(true)} /></Tooltip>
						</div>
						<ChatContent messageType={type} messageContent={content} fileSize={file_size} />
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
						<div className={styles.message_actions}>
							<Tooltip title="复制"><Button size="small" type="text" icon={<CopyOutlined />} onClick={handleCopy} /></Tooltip>
							<Tooltip title="本地隐藏"><Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setHidden(true)} /></Tooltip>
						</div>
						<ChatContent messageType={type} messageContent={content} fileSize={file_size} />
					</div>
				</div>
			)}
		</>
	);
};

export default MessageShow;
