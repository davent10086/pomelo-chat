import {Button,Spin,Tooltip } from 'antd';
import { ChangeEvent,useRef, useState } from 'react';
import { getGroupMembers } from './api';
import styles from './index.module.less';
import { IChatToolProps,IMessageListItem,ISendMessage } from './type';
import { EmojiList } from '@/assets/emoji';
import AudioModal from '../AudioModal';
import { ICallReceiverInfo } from '../AudioModal/type';
import VideoModal from '@/componments/VideoModal';
import useShowMessage from '../hooks/useShowMessage';
import { HttpStatus } from '@/utils/constant';
import { getFileSuffixByPath } from '@/utils/File';
import {uploadFile} from '@/utils/file-upload';
import { userStorage } from '@/utils/storage';
import { ChatIconList } from '@/assets/icons';

/**
 * 聊天工具栏组件
 * 提供文本输入、表情选择、文件上传、音视频通话等功能
 * @param props - 包含当前聊天信息和发送消息回调函数的属性对象
 * @returns 聊天工具栏 JSX 元素
 */
const ChatTool = (props: IChatToolProps) => {
	const { curChatInfo, sendMessage } = props;
	const user = JSON.parse(userStorage.getItem());
	const showMessage = useShowMessage();
	const [inputValue, setInputValue] = useState<string>('');
	const [loading, setLoading] = useState(false);
	const [openAudioModal, setAudioModal] = useState(false);
	const [openVideoModal, setVideoModal] = useState(false);
	const [callReceiverList, setCallReceiverList] = useState<ICallReceiverInfo[]>([]); // 音视频通话对象列表
	const imageRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	/**
	 * 处理输入框值变化事件
	 * @param e - 文本域变更事件对象
	 */
	const changeInputValue = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setInputValue(e.target.value);
	};

	/**
	 * 添加表情到输入框
	 * @param emoji - 要添加的表情符号
	 */
	const addEmoji = (emoji: string) => {
		setInputValue(prevValue => prevValue + emoji);
	};

	/**
	 * 发送文本消息
	 */
	const handleSendTextMessage = () => {
		if (inputValue === '') return;
		try {
			const newmessage: ISendMessage = {
				sender_id: user.id,
				receiver_id: curChatInfo.receiver_id,
				type: 'text',
				content: inputValue,
				avatar: user.avatar
			};
			sendMessage(newmessage);
			setInputValue(''); // 在发送消息成功后清空输入框内容
		} catch {
			showMessage('error', '消息发送失败，请重试');
		}
	};

	/**
	 * 发送文件消息（包括图片、视频等）
	 * 先上传文件获取URL，再发送消息
	 * @param e - 文件输入框变更事件对象
	 */
	const handleSendFileMessage = async (e: ChangeEvent<HTMLInputElement>) => {
		if (e.target.files!.length > 0) {
			setLoading(true);
			// 只能上传小于 2G 的文件
			const file = e.target.files![0];
			if (file.size > 2 * 1024 * 1024 * 1024) {
				showMessage('error', '文件大小不能超过 2G');
				setLoading(false);
				return;
			}
			try {
				const res = await uploadFile(file, 5);
				if (res.success && res.filePath) {
					try {
						const newmessage: ISendMessage = {
							sender_id: user.id,
							receiver_id: curChatInfo.receiver_id,
							type: getFileSuffixByPath(file.name),
							content: res.filePath,
							avatar: user.avatar,
							fileSize: file.size
						};
						sendMessage(newmessage);
					} catch {
						showMessage('error', '消息发送失败，请重试');
					}
				} else {
					showMessage('error', '文件上传失败，请重试');
				}
			} catch {
				showMessage('error', '文件上传失败，请重试');
			} finally {
				setLoading(false);
				imageRef.current!.value = '';
				fileRef.current!.value = '';
			}
		}
	};

	/**
	 * 控制音频通话弹窗显示/隐藏
	 * @param visible - 是否显示弹窗
	 */
	const handleAudioModal = (visible: boolean) => {
		setAudioModal(visible);
	};

	/**
	 * 控制视频通话弹窗显示/隐藏
	 * @param visible - 是否显示弹窗
	 */
	const handleVideoModal = (visible: boolean) => {
		setVideoModal(visible);
	};

	/**
	 * 处理点击工具栏图标事件
	 * 根据图标类型执行相应操作
	 * @param icon - 图标名称
	 */
	const handleIconClick = async (icon: string) => {
		switch (icon) {
			case 'icon-tupian_huaban':
				imageRef.current?.click();
				break;
			case 'icon-wenjian1':
				fileRef.current?.click();
				break;
			case 'icon-dianhua':
				await getCallReceiverList();
				setAudioModal(true);
				break;
			case 'icon-video':
				await getCallReceiverList();
				setVideoModal(true);
				break;
			default:
				break;
		}
	};

	// 表情列表组件
	const emojiList = (
		<div className={styles.emoji_list}>
			{EmojiList.map(item => {
				return (
					<span
						key={item}
						className={styles.emoji_item}
						onClick={() => {
							addEmoji(item);
						}}
						style={{ cursor: 'default' }}
					>
						{item}
					</span>
				);
			})}
		</div>
	);

	/**
	 * 判断当前聊天是否为群聊
	 * @param item - 消息列表项
	 * @returns 如果是群聊返回true，否则返回false
	 */
	const isGroupChat = (item: IMessageListItem) => {
		return !item.receiver_username;
	};

	/**
	 * 获取音视频通话联系人列表
	 * 如果是群聊则获取群成员列表，如果是私聊则获取对方信息
	 */
	const getCallReceiverList = async () => {
		if (isGroupChat(curChatInfo)) {
			try {
				const params = {
					groupId: curChatInfo.receiver_id,
					room: curChatInfo.room
				};
				const res = await getGroupMembers(params);
				if (res.code === HttpStatus.SUCCESS && res.data) {
					setCallReceiverList(
						res.data.map(item => {
							return {
								username: item.username,
								alias: item.nickname,
								avatar: item.avatar
							};
						})
					);
				} else {
					showMessage('error', '获取群聊成员信息失败，请重试');
				}
			} catch {
				showMessage('error', '获取群聊成员信息失败，请重试');
			}
		} else {
			setCallReceiverList([
				{
					username: curChatInfo.receiver_username as string,
					alias: curChatInfo.name,
					avatar: curChatInfo.avatar
				}
			]);
		}
	};

	return (
		<div className={styles.chat_tool}>
			<div className={styles.chat_tool_item}>
				<ul className={styles.leftIcons}>
					{ChatIconList.slice(0, 3).map((item, index) => {
						return (
							<Tooltip
								key={item.text}
								placement={index === 0 ? 'top' : 'bottomLeft'}
								title={index === 0 ? emojiList : item.text}
								arrow={false}
							>
								<li
									className={`iconfont ${item.icon}`}
									onClick={() => {
										handleIconClick(item.icon);
									}}
								></li>
							</Tooltip>
						);
					})}
				</ul>
				<ul className={styles.rightIcons}>
					{ChatIconList.slice(3, 6).map(item => {
						return (
							<Tooltip key={item.text} placement="bottomLeft" title={item.text} arrow={false}>
								<li
									className={`iconfont ${item.icon}`}
									onClick={() => {
										handleIconClick(item.icon);
									}}
								></li>
							</Tooltip>
						);
					})}
				</ul>
				<input
					type="file"
					accept="image/*,video/*"
					style={{ display: 'none' }}
					ref={imageRef}
					onChange={e => {
						handleSendFileMessage(e);
					}}
				/>
				<input
					type="file"
					accept="*"
					style={{ display: 'none' }}
					ref={fileRef}
					onChange={e => {
						handleSendFileMessage(e);
					}}
				/>
			</div>
			<div className={styles.chat_tool_input}>
				<Spin spinning={loading} tip="正在发送中...">
					<textarea
						onChange={e => {
							changeInputValue(e);
						}}
						value={inputValue}
					></textarea>
				</Spin>
			</div>
			<div className={styles.chat_tool_btn}>
				<Button type="primary" onClick={handleSendTextMessage}>
					发送
				</Button>
			</div>
			{
				// 音频通话弹窗
				openAudioModal && callReceiverList.length && (
					<AudioModal
						openmodal={openAudioModal}
						handleModal={handleAudioModal}
						status="initiate"
						type={isGroupChat(curChatInfo) ? 'group' : 'private'}
						callInfo={{
							room: curChatInfo.room,
							callReceiverList: callReceiverList
						}}
					/>
				)
			}
			{
				// 视频通话弹窗
				openVideoModal && callReceiverList.length && (
					<VideoModal
						openmodal={openVideoModal}
						handleModal={handleVideoModal}
						status="initiate"
						type={isGroupChat(curChatInfo) ? 'group' : 'private'}
						callInfo={{
							room: curChatInfo.room,
							callReceiverList: callReceiverList
						}}
					/>
				)
			}
		</div>
	);
};

export default ChatTool;
