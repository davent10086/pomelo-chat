import { Image,Modal } from "antd";
import { useState,useEffect } from "react";
import React from "react";
import styles from "./index.module.less";
import { IChatContentProps,IMessageShowProps,IMediaInfo } from "./type";
import ImageLoad from "../ImageLoad";
import { serverURL } from "@/config";
import { ChatImage, LoadErrorImage } from "../images";
import {
	getMediaSize,
	getMediaShowSize,
	getFileName,
	getFileIcon,
	downloadFile,
	urlExists
} from '@/utils/File';
import { userStorage } from '@/utils/storage';
import { formatChatContentTime } from '@/utils/time';

/**
 * 消息展示组件
 * 用于显示聊天消息，支持文本、图片、视频和文件类型
 * @param props - 包含消息显示相关属性的对象
 * @param props.showTime - 是否显示时间
 * @param props.message - 消息对象，包含发送者ID、内容、头像、类型等信息
 */
const MessageShow = (props:IMessageShowProps) => {
    const {showTime,message} = props;
    const user = JSON.parse(userStorage.getItem());
    const {sender_id,content,avatar,type,file_size,created_at} = message;
    
    /**
     * 文件过期或被清理时的占位组件
     */
    const ChatContentPocket = () => (
        <div className={`${styles.content_delete} ${styles.content_file}`}>
			<img src={LoadErrorImage.FILE_DELETE} draggable="false"></img>
			<span>文件已过期或被清理</span>
		</div>
    );

    /**
     * 聊天内容渲染组件
     * 根据消息类型渲染不同的内容（文本、图片、视频、文件）
     * @param props - 聊天内容属性
     * @param props.messageType - 消息类型（text/image/video/file）
     * @param props.messageContent - 消息内容（文本内容或文件路径）
     * @param props.fileSize - 文件大小
     * @returns 渲染的消息内容元素或null
     */
    const ChatContent = (props:IChatContentProps): React.ReactElement|null => {
        const { messageType, messageContent, fileSize } = props;
		const [curMediaInfo, setCurMediaInfo] = useState<IMediaInfo | null>(null);
		const [isVideoPlay, setIsVideoPlay] = useState<boolean>(false);
		const [isFileExist, setIsFileExist] = useState<boolean>(true);

        // 检查媒体文件是否存在，并获取图片/视频尺寸信息
        useEffect(() => {
            if (messageType !== 'text'){
                urlExists(`${serverURL}${messageContent}`).then(res => {
                    if(!res){
                        setIsFileExist(false);
                    }
                });
            }
            if(messageType === 'image'||messageType === 'video'){
                const mediaURL = serverURL + messageContent;
                getMediaSize(mediaURL, messageType)
                .then(size => {
                    setCurMediaInfo({type: messageType, url: mediaURL,size})
                })
                .catch(() => {
                setIsFileExist(false);
                });
            }
        },[messageType, messageContent]);

        const handleOpenVideo = () => {
            setIsVideoPlay(true);
        }

		if (!isFileExist) return <ChatContentPocket />;
		switch (messageType) {
			case 'text':
				return <div className={styles.content_text}>{messageContent}</div>;
			case 'image':
				return curMediaInfo && curMediaInfo ? (
					<Image
						width={getMediaShowSize(curMediaInfo.size, 'image').width}
						src={curMediaInfo.url}
						rootClassName="content_image"
					/>
				) : null;
			case 'video':
				return curMediaInfo && curMediaInfo ? (
					<div className={styles.content_video}>
						<video
							src={serverURL + messageContent}
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
							<video src={serverURL + messageContent} muted controls autoPlay width={750} />
						</Modal>
					</div>
				) : null;
			case 'file':
				return (
					<div
						className={styles.content_file}
						onClick={() => {
							downloadFile(`${serverURL}${messageContent}`);
						}}
					>
						<div className={styles.content_file_name}>
							<span>{getFileName(messageContent)}</span>
							{fileSize && <span>{fileSize}</span>}
						</div>
						<div className={styles.content_file_img}>
							<img src={getFileIcon(messageContent)} draggable="false"></img>
						</div>
					</div>
				);
			default:
				return null;
		}
	};

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
