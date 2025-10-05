	import { Drawer, Modal, Empty } from 'antd';
	import { useEffect, useRef, useState } from 'react';
	
	import { getRoomMembers } from '../AudioModal/api';
	import styles from './index.module.less';
	import {
		CallStatus,
		callStatusType,
		ICallModalProps,
		IConnectParams,
		ICallList,
		IRoomMembersItem
	} from '../AudioModal/type';
	
	import { CallIcons } from '@/assets/images';
	import ImageLoad from '@/componments/ImageLoad';
	import { wsBaseURL } from '@/config';
	import useShowMessage from '@/hooks/useShowMessage';
	import { HttpStatus } from '@/utils/constant';
	import { userStorage } from '@/utils/storage';
	import { formatCallTime } from '@/utils/time';
	
	/**
	 * 视频通话模态框组件
	 * @param props - 组件属性
	 * @param props.openmodal - 是否显示模态框
	 * @param props.handleModal - 控制模态框显示/隐藏的回调函数
	 * @param props.status - 通话状态
	 * @param props.type - 通话类型（私聊/群聊）
	 * @param props.callInfo - 通话相关信息
	 * @returns 视频通话模态框组件
	 */
	const VideoModal = (props: ICallModalProps) => {
		const showMessage = useShowMessage();
		const { openmodal, handleModal, status, type, callInfo } = props;
		const user = JSON.parse(userStorage.getItem());
		const [callStatus, setCallStatus] = useState<callStatusType>(status);
		const [duration, setDuration] = useState<number>(0);
		const [callList, setCallList] = useState<ICallList>({}); // 与 callListRef 作用类似，不过可以负责相关DOM的渲染
		const callListRef = useRef<ICallList>({}); // 主要负责存储通话对象信息，每个通话对象都有一个 RTCPeerConnection 实例，该实例是真正负责音视频通信的角色
		const [roomMembers, setRoomMembers] = useState<IRoomMembersItem[]>([]); // 当前房间内正在通话的所有人
		const [isShowRoomMembersDrawer, setIsRoomMembersDrawer] = useState<boolean>(false); // 是否显示当前通话人列表抽屉
		const localStream = useRef<MediaStream | null>(null); // 本地音视频流，用于存储自己的音视频流，方便结束时关闭
		const socket = useRef<WebSocket | null>(null); // websocket 实例
		const localVideoRef = useRef<HTMLVideoElement>(null); // 本地视频元素引用
	
		/**
		 * 初始化 WebSocket 连接
		 * @param connectParams - 连接参数，包含房间号、用户名和通话类型
		 */
		const initSocket = (connectParams: IConnectParams) => {
			// 如果 socket 已经存在，则重新建立连接
			if (socket.current !== null) {
				socket.current.close();
				socket.current = null;
			}
			const ws = new WebSocket(
				`${wsBaseURL}/rtc/connect?room=${connectParams.room}&username=${connectParams.username}&type=${connectParams.type}`
			);
			ws.onopen = async () => {
				// 如果是通话发起人，则初始化音视频流并发送创建房间指令
				if (callStatus === CallStatus.INITIATE) {
					try {
						// 1、获取并设置自己的音视频流
						await initStream();
						// 2、发送 create_room 指令，创建房间
						socket.current?.send(
							JSON.stringify({
								name: 'create_room',
								data: {
									room: connectParams.room,
									username: connectParams.username,
									type: connectParams.type
								}
							})
						);
						// 3、给所有通话对象发送 offer 指令，邀请他们进入房间
						callInfo.callReceiverList.forEach(item => {
							callListRef.current[item.username].PC?.createOffer().then(session_desc => {
								callListRef.current[item.username].PC?.setLocalDescription(session_desc);
								socket.current?.send(
									JSON.stringify({
										name: 'offer',
										data: {
											sdp: session_desc
										},
										receiver: item.username
									})
								);
							});
						});
					} catch {
						showMessage('error', '获取视频流失败，请检查设备是否正常或者权限是否已开启');
						handleModal(false);
					}
				}
			};
	
			// 监听 websocket 消息
			ws.onmessage = async evt => {
				const message = JSON.parse(evt.data);
				switch (message.name) {
					/**
					 * new_peer：当房间内有新人进入时，需要给新人创建 PC 通道并发送自己的 SDP
					 */
					case 'new_peer':
						// 初始化新人的 PC 通道
						initPC(message.sender);
						// 添加自己的音视频流到与该新人的 PC 通道中
						localStream.current!.getTracks().forEach(track => {
							callListRef.current[message.sender].PC!.addTrack(
								track,
								localStream.current as MediaStream
							);
						});
						// 创建并发送 offer 给新人
						callListRef.current[message.sender].PC!.createOffer().then(session_desc => {
							callListRef.current[message.sender].PC!.setLocalDescription(session_desc); // 邀请人设置本地 SDP，将会触发 PC.onicecandidate 事件，将自己的 candidate 发送给被邀请人
							socket.current?.send(
								JSON.stringify({
									name: 'offer',
									data: {
										sdp: session_desc
									},
									receiver: message.sender
								})
							);
						});
						break;
					/**
					 * offer：进入房间的新人收到并设置对方发送过来的 SDP 后，也发送自己的 SDP 给对方
					 */
					case 'offer':
						// 添加自己的音视频流到与该新人的 PC 通道中
						localStream.current!.getTracks().forEach(track => {
							callListRef.current[message.sender].PC!.addTrack(
								track,
								localStream.current as MediaStream
							);
						});
						// 设置远程 SDP
						callListRef.current[message.sender].PC!.setRemoteDescription(
							new RTCSessionDescription(message.data.sdp)
						);
						callListRef.current[message.sender].PC!.createAnswer().then(session_desc => {
							callListRef.current[message.sender].PC!.setLocalDescription(session_desc); // 被邀请人设置本地 SDP，将会触发 PC.onicecandidate 事件，将自己的 candidate 发送给邀请人
							socket.current?.send(
								JSON.stringify({
									name: 'answer',
									data: {
										sdp: session_desc
									},
									receiver: message.sender
								})
							);
						});
						break;
					/**
					 * answer：接收到房间新人发送过来的 SDP 后，设置对方的 SDP，此时双方的 SDP 设置完毕, 将会触发 PC.onicecandidate 事件，互相交换 candidate
					 */
					case 'answer':
						// 设置远程 SDP
						callListRef.current[message.sender].PC!.setRemoteDescription(
							new RTCSessionDescription(message.data.sdp)
						);
						break;
					/**
					 * ice_candidate：设置对方的 candidate
					 */
					case 'ice_candidate': {
						const candidate = new RTCIceCandidate(message.data);
						callListRef.current[message.sender].PC!.addIceCandidate(candidate);
						break;
					}
					/**
					 * reject：对方拒绝或挂断通话
					 */
					case 'reject':
						if (type === 'private') {
							socket.current?.close();
							socket.current = null;
							if (localStream.current) {
								localStream.current?.getTracks().forEach(track => track.stop());
							}
							setTimeout(() => {
								handleModal(false);
								showMessage('info', `对方已挂断`);
							}, 1500);
						} else {
							await getRoomMembersData();
							setTimeout(() => {
								showMessage('info', `${message.sender} 已退出群视频通话`);
							}, 1500);
							const video = document.querySelector(`.video_${message.sender}`) as HTMLVideoElement;
							if (video) {
								video.style.display = 'none';
							}
						}
						break;
					default:
						break;
				}
			};
			ws.onerror = () => {
				showMessage('error', 'websocket 连接错误');
			};
			socket.current = ws;
		};
	
		/**
		 * 初始化本地音视频流
		 */
		const initStream = async () => {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					video: true,
					audio: true
				});
				localStream.current = stream;
				
				// 设置本地视频流显示
				if (localVideoRef.current) {
					localVideoRef.current.srcObject = stream;
				}
			} catch {
				showMessage('error', '获取视频流失败，请检查设备是否正常或者权限是否已开启');
				handleModal(false);
			}
		};
	
		/**
		 * 初始化 RTCPeerConnection 连接
		 * @param username - 用户名
		 */
		const initPC = (username: string) => {
			const pc = new RTCPeerConnection();
			// 给 PC 绑定 onicecandidate 事件，该事件将会 PC 通道双方彼此的 SDP（会话描述协议）设置完成之后自动触发，给对方发送自己的 candidate 数据（接收 candidate，交换 ICE 网络信息）
			pc.onicecandidate = evt => {
				if (evt.candidate) {
					socket.current?.send(
						JSON.stringify({
							name: `ice_candidate`,
							data: {
								id: evt.candidate.sdpMid,
								label: evt.candidate.sdpMLineIndex,
								sdpMLineIndex: evt.candidate.sdpMLineIndex,
								candidate: evt.candidate.candidate
							},
							receiver: username
						})
					);
				}
			};
			// 给 PC 绑定 ontrack 事件，该事件用于接收远程视频流并播放，将会在双方交换并设置完 ICE 之后自动触发
			pc.ontrack = evt => {
				if (evt.streams && evt.streams[0]) {
					const video = document.querySelector(`.video_${username}`) as HTMLVideoElement;
					if (video) {
						video.srcObject = evt.streams[0];
					}
				}
			};
			callListRef.current[username] = {
				PC: pc,
				alias: callInfo.callReceiverList.find(item => item.username === username)?.alias || '',
				avatar: callInfo.callReceiverList.find(item => item.username === username)?.avatar || ''
			};
		};
	
		/**
		 * 接受通话（被邀请人使用）
		 */
		const handleAcceptCall = async () => {
			setCallStatus(CallStatus.CALLING);
			try {
				// 1、获取自己的音视频流
				await initStream();
				// 2、发送 new_peer 指令，告诉房间内其他人自己要进入房间
				socket.current?.send(
					JSON.stringify({
						name: 'new_peer'
					})
				);
				if (type !== 'private') {
					await getRoomMembersData();
				}
			} catch {
				showMessage('error', '获取视频流失败，请检查设备是否正常或者权限是否已开启');
				socket.current?.send(JSON.stringify({ name: 'reject' }));
				socket.current?.close();
				socket.current = null;
				if (localStream.current) {
					localStream.current?.getTracks().forEach(track => track.stop());
				}
				setTimeout(() => {
					handleModal(false);
				}, 1500);
			}
		};
	
		/**
		 * 拒绝/挂断通话
		 */
		const handleRejectCall = async () => {
			if (!socket.current) {
				return;
			}
			socket.current?.send(JSON.stringify({ name: 'reject' }));
			socket.current?.close();
			socket.current = null;
			setTimeout(() => {
				handleModal(false);
				if (localStream.current) {
					localStream.current?.getTracks().forEach(track => track.stop());
				}
				showMessage('info', `${type === 'private' ? '已挂断通话' : '已退出群视频通话'}`);
			}, 1500);
		};
	
		/**
		 * 获取当前房间内正在通话的所有成员
		 */
		const getRoomMembersData = async () => {
			try {
				const res = await getRoomMembers(callInfo.room);
				if (res.code === HttpStatus.SUCCESS && res.data) {
					const newRoomMembers = res.data.map(item => {
						return {
							username: item,
							muted: roomMembers.find(member => member.username === item)?.muted || false,
							showVideo: roomMembers.find(member => member.username === item)?.showVideo ?? true
						};
					});
					setRoomMembers(newRoomMembers);
				} else {
					showMessage('error', '获取房间成员失败');
				}
			} catch {
				showMessage('error', '获取房间成员失败');
			}
		};
	
		/**
		 * 禁音/解除禁音
		 * @param item - 房间成员信息
		 */
		const handleMute = (item: IRoomMembersItem) => {
			const video = document.querySelector(`.video_${item.username}`) as HTMLVideoElement;
			if (video && video.srcObject) {
				const stream = video.srcObject as MediaStream;
				const audioTracks = stream.getAudioTracks();
				if (audioTracks.length > 0) {
					audioTracks[0].enabled = !audioTracks[0].enabled;
				}
			}
			const newRoomMembers = roomMembers.map(member => {
				if (member.username === item.username) {
					member.muted = !member.muted;
				}
				return member;
			});
			setRoomMembers(newRoomMembers);
		};
	
		/**
		 * 开启/关闭视频
		 * @param item - 房间成员信息
		 */
		const handleToggleVideo = (item: IRoomMembersItem) => {
			const video = document.querySelector(`.video_${item.username}`) as HTMLVideoElement;
			if (video && video.srcObject) {
				const stream = video.srcObject as MediaStream;
				const videoTracks = stream.getVideoTracks();
				if (videoTracks.length > 0) {
					videoTracks[0].enabled = !videoTracks[0].enabled;
				}
			}
			const newRoomMembers = roomMembers.map(member => {
				if (member.username === item.username) {
					member.showVideo = !member.showVideo;
				}
				return member;
			});
			setRoomMembers(newRoomMembers);
		};
	
		// 打开组件时初始化 websocket 连接和 PC 通道
		useEffect(() => {
			const params: IConnectParams = {
				room: callInfo.room,
				username: user.username,
				type: type
			};
			initSocket(params);
			// 初始化所有的 PC 通道
			callInfo.callReceiverList.forEach(item => {
				initPC(item.username);
			});
		}, []);
	
		// callList 的初始化，用于渲染 video 标签
		// 修复：移除不必要的依赖项 callListRef.current
		useEffect(() => {
			setCallList(callListRef.current);
		},[]);
	
		// 当有人和自己通话时，监听通话时间
		useEffect(() => {
			if (callStatus === CallStatus.CALLING) {
				const timer = setInterval(() => {
					setDuration(duration => duration + 1);
				}, 1000);
				return () => {
					clearInterval(timer);
				};
			}
		}, [callStatus]);
	
		return (
			<>
				<Modal
					open={openmodal}
					footer={null}
					wrapClassName="videoModal"
					width="8rem"
					title={`${type === 'private' ? '' : '群'}视频通话 `}
					maskClosable={false}
					closable={type === 'private' ? false : true}
					closeIcon={type === 'private' ? null : <span className="iconfont icon-jinqunliaoliao" />}
					onCancel={async () => {
						setIsRoomMembersDrawer(!isShowRoomMembersDrawer);
						if (type !== 'private' && callStatus !== CallStatus.CALLING) {
							await getRoomMembersData();
						}
					}}
				>
					<div className={styles.videoModalContent}>
						<div className={styles.localVideoContainer}>
							<video 
								ref={localVideoRef}
								autoPlay 
								muted 
								className={styles.localVideo}
							/>
							<span className={styles.localUsername}>{user.username}</span>
						</div>
						
						<div className={styles.remoteVideosContainer}>
							{callStatus === CallStatus.INITIATE && (
								<div className={styles.callInitiate}>
									<div className={styles.avatar}>
										<ImageLoad
											src={type === 'private' ? callInfo.callReceiverList[0].avatar : CallIcons.VIDEO} 
										/>
									</div>
									<span className={styles.callWords}>
										{type === 'private'
											? ` 正在对 ${callInfo.callReceiverList[0].alias} 发起视频通话... `
											: '正在发起群视频通话...'}
									</span>
									<div className={styles.callIcons}>
										<img src={CallIcons.REJECT} alt="" onClick={handleRejectCall} draggable="false" />
									</div>
								</div>
							)}
							
							{callStatus === CallStatus.RECEIVE && (
								<div className={styles.callReceive}>
									<div className={styles.avatar}>
										<ImageLoad
											src={type === 'private' ? callInfo.callReceiverList[0].avatar : CallIcons.VIDEO} 
											alt='avatar'
										/>
									</div>
									<span className={styles.callWords}>
										{type === 'private'
											? `${callInfo.callReceiverList[0].alias} 邀请您视频通话 `
											: '有人邀请您加入群视频通话'}
									</span>
									<div className={styles.callIcons}>
										<img src={CallIcons.ACCEPT} alt="" onClick={handleAcceptCall} draggable="false" />
										<img src={CallIcons.REJECT} alt="" onClick={handleRejectCall} draggable="false" />
									</div>
								</div>
							)}
							
							{callStatus === CallStatus.CALLING && (
								<div className={styles.callingContainer}>
									{callList &&
										Object.keys(callList).map(username => {
											if (username === user.username) return null;
											return (
												<div key={username} className={styles.remoteVideoContainer}>
													<video
														src=""
														className={`video_${username}`}
														autoPlay
													></video>
													<span className={styles.remoteUsername}>{callList[username].alias}</span>
												</div>
											);
										})}
									<span className={styles.callWords}>{formatCallTime(duration)}</span>
									<div className={styles.callIcons}>
										<img src={CallIcons.REJECT} alt="" onClick={handleRejectCall} draggable="false" />
									</div>
								</div>
							)}
						</div>
						
						{type !== 'private' && (
							<Drawer
								title="当前正在通话的群成员"
								placement="right"
								closable={false}
								onClose={() => {
									setIsRoomMembersDrawer(false);
								}}
								open={isShowRoomMembersDrawer}
								getContainer={false}
								width="50%"
								forceRender={true}
								className="memberDrawer"
							>
								{roomMembers.length ? (
									<ul className={styles.memberList}>
										{roomMembers.map(item => {
											return (
												<li key={item.username} className={styles.memberItem}>
													<span>{item.username}</span>
													<div className={styles.memberControls}>
														<span
															className={`iconfont ${item.muted ? 'icon-jingyin' : 'icon-yuyintonghua'}`}
															onClick={() => handleMute(item)}
														></span>
														<span
															className={`iconfont ${item.showVideo ? 'icon-shipin' : 'icon-guanbishipin'}`}
															onClick={() => handleToggleVideo(item)}
														></span>
													</div>
												</li>
											);
										})}
									</ul>
								) : (
									<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成员" />
								)}
							</Drawer>
						)}
					</div>
				</Modal>
			</>
		);
	};
	
	export default VideoModal;