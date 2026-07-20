import { Image, Modal } from 'antd';
import { useEffect, useState } from 'react';

import styles from './index.module.less';
import { IChatContentProps, IMessageShowProps, IMediaInfo } from './type';

import { ChatImage, LoadErrorImage } from '@/assets/images';
import ImageLoad from '@/components/ImageLoad';
import {
	getMediaSize,
	getMediaShowSize,
	getFileName,
	getFileIcons,
	downloadFile,
	urlExists
} from '@/utils/File';
import { userStorage } from '@/utils/storage';
import { getAuthorizedMediaURL } from '@/utils/media-url';
import { formatChatContentTime } from '@/utils/time';

/**
 * M8: 提取为模块级组件，避免在父组件函数体内定义导致重挂载
 * 图片/视频和文件被清理时的兜底显示
 */
const ChatContentPocket = () => (
	<div className={`${styles.content_delete} ${styles.content_file}`}>
		<img src={LoadErrorImage.FILE_DELETE} draggable="false" alt="文件已过期" />
		<span>文件已过期或被清理</span>
	</div>
);

/**
 * M8: 提取为模块级组件，保留内部 state 与 effect
 * 消息内容 (分为文本、图片、视频和文件)
 */
const ChatContent = (props: IChatContentProps): JSX.Element | null => {
	const { messageType, messageContent, fileSize } = props;
	const [curMediaInfo, setCurMediaInfo] = useState<IMediaInfo | null>(null);
	const [isVideoPlay, setIsVideoPlay] = useState<boolean>(false);
	const [isFileExist, setIsFileExist] = useState<boolean>(true);

	useEffect(() => {
		if (messageType !== 'text') {
			urlExists(getAuthorizedMediaURL(messageContent)).then(res => {
				if (!res) {
					setIsFileExist(res);
				}
			});
		}
		if (messageType === 'image' || messageType === 'video') {
			const mediaURL = getAuthorizedMediaURL(messageContent);
			getMediaSize(mediaURL, messageType)
				.then(size => {
					setCurMediaInfo({ type: messageType, url: mediaURL, size });
				})
				.catch(() => {
					/* empty */
				});
		}
	}, [messageType, messageContent]);

	const handleOpenVideo = () => {
		setIsVideoPlay(true);
	};

	if (!isFileExist) return <ChatContentPocket />;
	switch (messageType) {
		case 'text':
			return <div className={styles.content_text}>{messageContent}</div>;
		case 'image':
			// L2: 移除冗余的 curMediaInfo && curMediaInfo 判断
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
						style={{
							width: getMediaShowSize(curMediaInfo.size, 'video').width
						}}
					/>
					<img src={ChatImage.PLAY} alt="" onClick={handleOpenVideo} draggable="false" />
					<Modal
						open={isVideoPlay}
						footer={null}
						title="视频"
						onCancel={() => setIsVideoPlay(false)}
						destroyOnClose
						width={800}
					>
						<video src={getAuthorizedMediaURL(messageContent)} muted controls autoPlay width={750} />
					</Modal>
				</div>
			) : (
				<div className={styles.content_media_placeholder} />
			);
		case 'file':
			return (
				<div
					className={styles.content_file}
					onClick={() => {
						downloadFile(getAuthorizedMediaURL(messageContent));
					}}
				>
					<div className={styles.content_file_name}>
						<span>{getFileName(messageContent)}</span>
						{fileSize && <span>{fileSize}</span>}
					</div>
					<div className={styles.content_file_img}>
						<img src={getFileIcons(messageContent)} draggable="false" alt="文件" />
					</div>
				</div>
			);
		default:
			return null;
	}
};

const MessageShow = (props: IMessageShowProps) => {
	const { showTime, message } = props;
	// H11: userStorage.getItem() 已返回对象，无需 JSON.parse
	const user = userStorage.getItem();
	const { sender_id, content, avatar, type, file_size, created_at } = message;

	return (
		<>
			{showTime && created_at && (
				<div className={styles.chat_notice}>
					<span>{formatChatContentTime(created_at)}</span>
				</div>
			)}
			{sender_id === user.id ? (
				<div className={`${styles.self} ${styles.chat_item_content}`}>
					<ChatContent messageType={type} messageContent={content} fileSize={file_size} />
					<div className={styles.avatar}>
						<ImageLoad src={avatar} />
					</div>
				</div>
			) : (
				<div className={`${styles.other} ${styles.chat_item_content}`}>
					<div className={styles.avatar}>
						<ImageLoad src={avatar} />
					</div>
					<ChatContent messageType={type} messageContent={content} fileSize={file_size} />
				</div>
			)}
		</>
	);
};

export default MessageShow;
