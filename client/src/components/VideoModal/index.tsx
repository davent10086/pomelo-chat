import { Drawer, Empty, Modal } from 'antd';
import { useEffect, useState } from 'react';

import styles from './index.module.less';
import { inviteToCall } from '@/components/AudioModal/livekit-api';
import { LiveKitMedia } from '@/components/AudioModal/LiveKitMedia';
import { CallStatus, type ICallModalProps } from '@/components/AudioModal/type';
import { CallIcons } from '@/assets/images';
import ImageLoad from '@/components/ImageLoad';
import useShowMessage from '@/hooks/useShowMessage';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import { formatCallTime } from '@/utils/time';

const VideoModal = ({ openmodal, handleModal, status, type, callInfo }: ICallModalProps) => {
	const showMessage = useShowMessage();
	const [callStatus, setCallStatus] = useState(status);
	const [duration, setDuration] = useState(0);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const { join, leave, participants, localVideoTrack, connectionState } = useLiveKitCall(callInfo.room, type, 'video');
	const start = async () => {
		try {
			if (status === CallStatus.INITIATE) await inviteToCall(callInfo.room, type, type === 'private' ? 'private_video' : 'group_video');
			await join(); setCallStatus(CallStatus.CALLING);
		} catch { await leave(); showMessage('error', '无法连接视频通话，请检查 LiveKit 服务和设备权限'); handleModal(false); }
	};
	const hangup = async () => { await leave(); handleModal(false); showMessage('info', type === 'private' ? '已挂断通话' : '已退出群视频通话'); };
	useEffect(() => { if (status === CallStatus.INITIATE) void start(); }, []);
	useEffect(() => { if (callStatus !== CallStatus.CALLING) return; const id = setInterval(() => setDuration(value => value + 1), 1000); return () => clearInterval(id); }, [callStatus]);
	return <Modal open={openmodal} footer={null} wrapClassName="videoModal" width="5rem" title={`${type === 'private' ? '' : '群'}视频通话`} maskClosable={false} closable={type !== 'private'} onCancel={() => setDrawerOpen(true)}>
		<div className={styles.videoModalContent}><div className={styles.content}>
			{callStatus !== CallStatus.CALLING && <div className={styles.avatar}><ImageLoad src={type === 'private' ? callInfo.callReceiverList[0]?.avatar : CallIcons.VIDEO} /></div>}
			{callStatus === CallStatus.INITIATE && <><span className={styles.callWords}>正在发起视频通话…</span><div className={styles.callIcons}><img src={CallIcons.REJECT} alt="挂断" onClick={hangup} /></div></>}
			{callStatus === CallStatus.RECEIVE && <><span className={styles.callWords}>{type === 'private' ? `${callInfo.callReceiverList[0]?.alias} 发起视频通话` : '有人邀请您加入群视频通话'}</span><div className={styles.callIcons}><img src={CallIcons.ACCEPT} alt="接听" onClick={() => void start()} /><img src={CallIcons.REJECT} alt="拒绝" onClick={hangup} /></div></>}
			{callStatus === CallStatus.CALLING && <div className={styles.callingStatus}>{participants.map(item => <div key={item.identity} className={type === 'private' ? styles.friendVideoParent : styles.videoParent}><LiveKitMedia track={item.videoTrack} video className={type === 'private' ? styles.friendVideo : styles.groupMemberVideo} /><span>{item.identity}</span><LiveKitMedia track={item.audioTrack} /></div>)}{localVideoTrack && <LiveKitMedia track={localVideoTrack} video className={styles.selfVideo} />}<div className={styles.bottom}><span className={styles.callWords}>{connectionState === 'connected' ? formatCallTime(duration) : '正在连接…'}</span><div className={styles.callIcons}><img src={CallIcons.REJECT} alt="挂断" onClick={hangup} /></div></div></div>}
			{type === 'group' && <Drawer title="当前正在通话的群成员" placement="right" closable={false} onClose={() => setDrawerOpen(false)} open={drawerOpen} getContainer={false} width="50%" className="memberDrawer">{participants.length ? participants.map(item => <li key={item.identity}>{item.identity}</li>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无群友加入通话" />}</Drawer>}
		</div></div>
	</Modal>;
};
export default VideoModal;
