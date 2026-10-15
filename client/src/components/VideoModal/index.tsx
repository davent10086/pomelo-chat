import { Drawer, Empty, Modal } from 'antd';
import { useState } from 'react';

import styles from './index.module.less';
import { LiveKitMedia } from '@/components/AudioModal/LiveKitMedia';
import { CallStatus, type ICallModalProps } from '@/components/AudioModal/type';
import { CallIcons } from '@/assets/images';
import ImageLoad from '@/components/ImageLoad';
import { useCallController } from '@/hooks/useCallController';
import { formatCallTime } from '@/utils/time';

const VideoModal = ({ openmodal, handleModal, status, type, callInfo }: ICallModalProps) => {
	const { callStatus, duration, start, hangup, participants, connectionState, localVideoTrack } =
		useCallController({ callInfo, status, type, handleModal }, 'video');
	const [drawerOpen, setDrawerOpen] = useState(false);
	return (
		<Modal
			open={openmodal}
			footer={null}
			wrapClassName="videoModal"
			width="5rem"
			title={`${type === 'private' ? '' : '群'}视频通话`}
			maskClosable={false}
			closable={type !== 'private'}
			onCancel={() => setDrawerOpen(true)}
		>
			<div className={styles.videoModalContent}>
				<div className={styles.content}>
					{callStatus !== CallStatus.CALLING && (
						<div className={styles.avatar}>
							<ImageLoad
								src={type === 'private' ? callInfo.callReceiverList[0]?.avatar : CallIcons.VIDEO}
							/>
						</div>
					)}
					{callStatus === CallStatus.INITIATE && (
						<>
							<span className={styles.callWords}>正在发起视频通话…</span>
							<div className={styles.callIcons}>
								<img src={CallIcons.REJECT} alt="挂断" onClick={hangup} />
							</div>
						</>
					)}
					{callStatus === CallStatus.RECEIVE && (
						<>
							<span className={styles.callWords}>
								{type === 'private'
									? `${callInfo.callReceiverList[0]?.alias} 发起视频通话`
									: '有人邀请您加入群视频通话'}
							</span>
							<div className={styles.callIcons}>
								<img src={CallIcons.ACCEPT} alt="接听" onClick={() => void start()} />
								<img src={CallIcons.REJECT} alt="拒绝" onClick={hangup} />
							</div>
						</>
					)}
					{callStatus === CallStatus.CALLING && (
						<div className={styles.callingStatus}>
							{participants.map(item => (
								<div
									key={item.identity}
									className={type === 'private' ? styles.friendVideoParent : styles.videoParent}
								>
									<LiveKitMedia
										track={item.videoTrack}
										video
										className={type === 'private' ? styles.friendVideo : styles.groupMemberVideo}
									/>
									<span>{item.identity}</span>
									<LiveKitMedia track={item.audioTrack} />
								</div>
							))}
							{localVideoTrack && (
								<LiveKitMedia track={localVideoTrack} video className={styles.selfVideo} />
							)}
							<div className={styles.bottom}>
								<span className={styles.callWords}>
									{connectionState === 'connected' ? formatCallTime(duration) : '正在连接…'}
								</span>
								<div className={styles.callIcons}>
									<img src={CallIcons.REJECT} alt="挂断" onClick={hangup} />
								</div>
							</div>
						</div>
					)}
					{type === 'group' && (
						<Drawer
							title="当前正在通话的群成员"
							placement="right"
							closable={false}
							onClose={() => setDrawerOpen(false)}
							open={drawerOpen}
							getContainer={false}
							width="50%"
							className="memberDrawer"
						>
							{participants.length ? (
								participants.map(item => <li key={item.identity}>{item.identity}</li>)
							) : (
								<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无群友加入通话" />
							)}
						</Drawer>
					)}
				</div>
			</div>
		</Modal>
	);
};
export default VideoModal;
