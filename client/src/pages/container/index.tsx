import { MessageOutlined, ContactsOutlined, FolderOutlined, LogoutOutlined } from '@ant-design/icons';
import { Tooltip, Button, Popover } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

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
import ChatFiles from '@/pages/files';
import { HttpStatus } from '@/utils/constant';
import { handleLogout } from '@/utils/logout';
import { clearSessionStorage, tokenStorage, userStorage } from '@/utils/storage';
import { safeParse } from '@/utils/safe-parse';
import ReconnectingWebSocket from '@/utils/websocket';
import Request from '@/utils/request';

const navigationIcons = { 'icon-message': <MessageOutlined />, 'icon-24px': <ContactsOutlined />, 'icon-wenjian': <FolderOutlined />, 'icon-tuichudenglu': <LogoutOutlined /> };

const Container = () => {
	const showMessage = useShowMessage();
	const navigate = useNavigate();
	const location = useLocation();
	// H11: userStorage.getItem() 已返回对象，无需 JSON.parse
	const user = userStorage.getItem();
	const username = user.username;
	const [currentIcon, setCurrentIcon] = useState<string>('icon-message');
	useEffect(() => {
		setCurrentIcon(location.pathname === '/files' ? 'icon-wenjian' : location.pathname === '/address-book' ? 'icon-24px' : 'icon-message');
	}, [location.pathname]);
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
	const [callId, setCallId] = useState<string>();
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
					socket.current.destroy();
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
	const initSocket = useCallback(() => {
		socket.current?.destroy();
		const token = tokenStorage.getItem();
		const ws = new ReconnectingWebSocket(
			`${wsBaseURL}/auth/user_channel?username=${encodeURIComponent(username)}`, undefined, ['pomelo-token', token]
		);

		ws.onMessage = e => {
			// H11: safeParse 保护，非法 JSON 不致白屏
			const message = safeParse<{ name: string; callId?: string; status?: string; memberStatus?: string; callReceiverList?: ICallReceiverInfo[]; room?: string; mode?: string }>(e.data, { name: '' });
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
				case 'call_state':
					window.dispatchEvent(new CustomEvent('pomelo-call-state', {detail: message}));
					break;
				case 'create_room': {
					try {
						const { callReceiverList, room, mode } = message;
						if (callReceiverList && room && mode) {
							setCallId(message.callId);
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
			void Request.get<{ call: { callId: string; room: string; mode: string; callReceiverList: ICallReceiverInfo[] } | null }>('/rtc/current').then(result => {
				const call = result.data.data?.call;
				if (socket.current !== ws || tokenStorage.getItem() !== token || !call) return;
				setCallId(call.callId); setRoom(call.room); setCurMode(call.mode); setCallReceiverList(call.callReceiverList);
				if (call.mode.includes('audio')) setAudioModal(true); else setVideoModal(true);
			}).catch(() => undefined);
		};

		ws.onClose = event => {
			if (event.code === 4001) setTimeout(() => {
				if (tokenStorage.getItem() !== token) return;
				clearSessionStorage(); navigate('/login');
			},300);
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
	}, [username, navigate, showMessage]);
	// L1: 添加 cleanup，组件卸载时关闭 socket
	useEffect(() => {
		initSocket();
		return () => {
			if (socket.current) {
				socket.current.destroy();
				socket.current = null;
			}
		};
	}, [initSocket]);

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
									<button
										type="button"
										className={currentIcon === item.icon ? styles.navSelected : undefined}
										aria-current={currentIcon === item.icon ? "page" : undefined}
										aria-label={item.text}
										onClick={() => {
											if (item.text === '聊天' || item.text === '通讯录' || item.text === '聊天文件') {
												setCurrentIcon(item.icon);
												navigate(item.text === '聊天' ? '/chat' : item.text === '聊天文件' ? '/files' : '/address-book');
											}
										}}
										style={{
											color: currentIcon === item.icon ? '#3390EC' : '#697C93'
										}}
									>{navigationIcons[item.icon as keyof typeof navigationIcons]}</button>
								</Tooltip>
							))}
						</ul>
						<ul className={styles.bottomIcons}>
							{MenuIconList.filter(item => item.text === '退出登录').map(item => (
								<Tooltip key={item.text} placement="bottomLeft" title={item.text} arrow={false}>
									<button
										type="button"
										className={currentIcon === item.icon ? styles.navSelected : undefined}
										aria-current={currentIcon === item.icon ? "page" : undefined}
										aria-label={item.text}
										onClick={() => {
											setCurrentIcon(item.icon);
											confirmLogout();
										}}
										style={{
											color: currentIcon === item.icon ? '#3390EC' : '#697C93'
										}}
									>{navigationIcons[item.icon as keyof typeof navigationIcons]}</button>
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
						) : currentIcon === 'icon-wenjian' ? <ChatFiles /> : (
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
					callInfo={{ room, callId, callReceiverList }}
				/>
			)}
			{openVideoModal && callReceiverList.length && (
				<VideoModal
					openmodal={openVideoModal}
					handleModal={handleVideoModal}
					status="receive"
					type={curMode.includes('private') ? 'private' : 'group'}
					callInfo={{ room, callId, callReceiverList }}
				/>
			)}
		</div>
	);
};

export default Container;
