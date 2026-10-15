import { Drawer, Empty, Modal } from 'antd';
import { useState } from 'react';

import styles from './index.module.less';
import { LiveKitMedia } from './LiveKitMedia';
import { CallStatus, type ICallModalProps } from './type';
import { CallIcons } from '@/assets/images';
import ImageLoad from '@/components/ImageLoad';
import { useCallController } from '@/hooks/useCallController';
import { formatCallTime } from '@/utils/time';

const AudioModal = ({ openmodal, handleModal, status, type, callInfo }: ICallModalProps) => {
	const { callStatus, duration, start, hangup, participants, connectionState } = useCallController(
		{ callInfo, status, type, handleModal },
		'audio'
	);
	const [drawerOpen, setDrawerOpen] = useState(false);
	return (
		<Modal
			open={openmodal}
			footer={null}
			wrapClassName="audioModal"
			width="5rem"
			title={`${type === 'private' ? '' : '群'}语音通话`}
			maskClosable={false}
			closable={type !== 'private'}
			onCancel={() => setDrawerOpen(true)}
		>
			<div className={styles.audioModalContent}>
				<div className={styles.content}>
					<div className={styles.avatar}>
						<ImageLoad
							src={type === 'private' ? callInfo.callReceiverList[0]?.avatar : CallIcons.AUDIO}
						/>
					</div>
					{callStatus === CallStatus.INITIATE && (
						<>
							<span className={styles.callWords}>正在发起语音通话…</span>
							<div className={styles.callIcons}>
								<img src={CallIcons.REJECT} alt="挂断" onClick={hangup} />
							</div>
						</>
					)}
					{callStatus === CallStatus.RECEIVE && (
						<>
							<span className={styles.callWords}>
								{type === 'private'
									? `${callInfo.callReceiverList[0]?.alias} 发起语音通话`
									: '有人邀请您加入群语音通话'}
							</span>
							<div className={styles.callIcons}>
								<img src={CallIcons.ACCEPT} alt="接听" onClick={() => void start()} />
								<img src={CallIcons.REJECT} alt="拒绝" onClick={hangup} />
							</div>
						</>
					)}
					{callStatus === CallStatus.CALLING && (
						<>
							<>
								{participants.map(item => (
									<LiveKitMedia key={item.identity} track={item.audioTrack} />
								))}
							</>
							<span className={styles.callWords}>
								{connectionState === 'connected' ? formatCallTime(duration) : '正在连接…'}
							</span>
							<div className={styles.callIcons}>
								<img src={CallIcons.REJECT} alt="挂断" onClick={hangup} />
							</div>
						</>
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
								participants.map(member => <li key={member.identity}>{member.identity}</li>)
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
export default AudioModal;
