import { Tooltip, Button, Popover } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import styles from './index.module.less';
import { IChatRef, IAddressBookRef } from './type';

import { MenuIconList } from '@/assets/icons';
import AudioModal from '@/components/AudioModal';
import { ICallReceiverInfo } from '@/components/AudioModal/type';
import ChangePerInfoModal from '@/components/ChangePerInfoModal';
import ChangePwdModal from '@/components/ChangePwdModal';
import { IGroupChatInfo } from '@/components/CreateGroupChatModal/type';
import ImageLoad from '@/components/ImageLoad';
import VideoModal from '@/components/VideoModal';
import { wsBaseURL } from '@/config';
import useShowMessage from '@/hooks/useShowMessage';
import AddressBook from '@/pages/address-book';
import { IFriendInfo } from '@/pages/address-book/type';
import Chat from '@/pages/chat';
import { HttpStatus } from '@/utils/constant';
import { handleLogout } from '@/utils/logout';
import { clearSessionStorage, tokenStorage, userStorage } from '@/utils/storage';
import { safeParse } from '@/utils/safe-parse';
import ReconnectingWebSocket from '@/utils/websocket';

const Container = () => {
	const showMessage = useShowMessage();
	const navigate = useNavigate();
	// H11: userStorage.getItem() 已返回对象，无需 JSON.parse
	const user = userStorage.getItem();
	const [currentIcon, setCurrentIcon] = useState<string>('icon-message');
	const [openForgetModal, setForgetModal] = useState(false);
	const [openInfoModal, setInfoModal] = useState(false);
	const [openAudioModal, setAudioModal] = useState(false);
	const [openVideoModal, setVideoModal] = useState(false);
	const socket = useRef<ReconnectingWebSocket | null>(null);
	const addressBookRef = useRef<IAddressBookRef>(null);
	const chatRef = useRef<IChatRef>(null);
	const [initSelectedChat, setInitSelectedChat] = useState<IFriendInfo | IGroupChatInfo | null>(
		null
	);
	const [room, setRoom] = useState<string>('');
	const [curMode, setCurMode] = useState<string>('');
	const [callReceiverList, setCallReceiverList] = useState<ICallReceiverInfo[]>([]);

	const handleForgetModal = (visible: boolean) => setForgetModal(visible);
	const handleInfoModal = (visible: boolean) => setInfoModal(visible);
	const handleAudioModal = (visible: boolean) => setAudioModal(visible);
	const handleVideoModal = (visible: boolean) => setVideoModal(visible);

	const confirmLogout = async () => {
		try {
			const res = await handleLogout(user);
			if (res.code === HttpStatus.SUCCESS) {
				clearSessionStorage();
				showMessage('success', '退出成功');
				if (socket.current !== null) {
					socket.current.close();
					socket.current = null;
				}
				navigate('/login');
			} else {
				showMessage('error', '退出失败, 请重试');
			}
		} catch {
			showMessage('error', '退出失败, 请重试');
		}
	};

	const infoContent = (
		<div className={styles.infoContent}>
			<div className={styles.infoContainer}>
				<div className={styles.avatar}>
					<ImageLoad src={user.avatar} />
				</div>
				<div className={styles.info}>
					<div className={styles.name}>{user.name}</div>
					<div className={styles.phone}> 手机号：{user.phone}</div>
					<div className={styles.signature}>
						{user.signature === '' ? '暂无个性签名' : user.signature}
					</div>
				</div>
			</div>
			<div className={styles.btnContainer}>
				<Button
					size="small"
					onClick={() => {
						handleForgetModal(true);
					}}
				>
					修改密码
				</Button>
				<Button
					size="small"
					onClick={() => {
						handleInfoModal(true);
					}}
				>
					修改信息
				</Button>
			</div>
		</div>
	);

	// 进入主页面时建立 websocket 连接（H3: 携带 token 认证）
	const initSocket = () => {
		const token = tokenStorage.getItem();
		const ws = new ReconnectingWebSocket(
			`${wsBaseURL}/auth/user_channel?username=${user.username}&token=${encodeURIComponent(token)}`
		);

		ws.onMessage = e => {
			// H11: safeParse 保护，非法 JSON 不致白屏
			const message = safeParse<{ name: string; callReceiverList?: ICallReceiverInfo[]; room?: string; mode?: string }>(e.data, { name: '' });
			switch (message.name) {
				case 'friendList':
					addressBookRef.current?.refreshFriendList();
					break;
				case 'groupChatList':
					addressBookRef.current?.refreshGroupChatList();
					break;
				case 'chatList':
					chatRef.current?.refreshChatList();
					break;
				case 'create_room': {
					try {
						const { callReceiverList, room, mode } = message;
						if (callReceiverList && room && mode) {
							setCallReceiverList(callReceiverList);
							setRoom(room);
							setCurMode(mode);
							if (mode.includes('audio')) {
								setAudioModal(true);
							} else {
								setVideoModal(true);
							}
						}
					} catch {
						showMessage('error', '音视频通话响应失败');
					}
					break;
				}
			}
		};

		ws.onOpen = () => {
			console.log('[通知管道] 连接成功');
			addressBookRef.current?.refreshFriendList();
			addressBookRef.current?.refreshGroupChatList();
			chatRef.current?.refreshChatList();
		};

		ws.onError = () => {
			console.error('[通知管道] 连接出错，将自动重连');
		};

		ws.onReconnecting = retryCount => {
			console.log(`[通知管道] 正在重连... 第 ${retryCount} 次`);
		};

		ws.onMaxRetriesReached = () => {
			showMessage('error', '通知服务连接失败，请刷新页面重试');
		};

		ws.connect();
		socket.current = ws;
	};
	// L1: 添加 cleanup，组件卸载时关闭 socket
	useEffect(() => {
		initSocket();
		return () => {
			if (socket.current) {
				socket.current.close();
				socket.current = null;
			}
		};
	}, []);

	const handleChooseChat = (item: IFriendInfo | IGroupChatInfo) => {
		setCurrentIcon('icon-message');
		navigate('/chat');
		setInitSelectedChat(item);
	};

	return (
		<div className={styles.parentContainer}>
			<div className={styles.container}>
				<div className={styles.leftContainer}>
					<Popover content={infoContent} placement="rightTop">
						<div className={styles.avatar}>
							<ImageLoad src={user.avatar} />
						</div>
					</Popover>
					<div className={styles.iconList}>
						<ul className={styles.topIcons}>
							{MenuIconList.filter(item => item.text !== '退出登录').map(item => (
								<Tooltip key={item.text} placement="bottomLeft" title={item.text} arrow={false}>
									<li
										className={`iconfont ${item.icon}`}
										onClick={() => {
											if (item.text === '聊天' || item.text === '通讯录') {
												setCurrentIcon(item.icon);
												navigate(item.text === '聊天' ? '/chat' : '/address-book');
											}
										}}
										style={{
											color: currentIcon === item.icon ? '#07c160' : '#979797'
										}}
									></li>
								</Tooltip>
							))}
						</ul>
						<ul className={styles.bottomIcons}>
							{MenuIconList.filter(item => item.text === '退出登录').map(item => (
								<Tooltip key={item.text} placement="bottomLeft" title={item.text} arrow={false}>
									<li
										className={`iconfont ${item.icon}`}
										onClick={() => {
											setCurrentIcon(item.icon);
											confirmLogout();
										}}
										style={{
											color: currentIcon === item.icon ? '#07c160' : '#979797'
										}}
									></li>
								</Tooltip>
							))}
						</ul>
					</div>
					<div className={styles.bottomIcons}></div>
					<div className={styles.topicons}></div>
					<div className={styles.bottomicons}></div>
				</div>
				<div className={styles.rightContainer}>
					{currentIcon === 'icon-message' ? (
						<Chat initSelectedChat={initSelectedChat} ref={chatRef} />
					) : (
						<AddressBook handleChooseChat={handleChooseChat} ref={addressBookRef} />
					)}
				</div>
			</div>
			{openForgetModal && (
				<ChangePwdModal openmodal={openForgetModal} handleModal={handleForgetModal} />
			)}
			{openInfoModal && (
				<ChangePerInfoModal openmodal={openInfoModal} handleModal={handleInfoModal} />
			)}
			{openAudioModal && callReceiverList.length && (
				<AudioModal
					openmodal={openAudioModal}
					handleModal={handleAudioModal}
					status="receive"
					type={curMode.includes('private') ? 'private' : 'group'}
					callInfo={{ room, callReceiverList }}
				/>
			)}
			{openVideoModal && callReceiverList.length && (
				<VideoModal
					openmodal={openVideoModal}
					handleModal={handleVideoModal}
					status="receive"
					type={curMode.includes('private') ? 'private' : 'group'}
					callInfo={{ room, callReceiverList }}
				/>
			)}
		</div>
	);
};

export default Container;
