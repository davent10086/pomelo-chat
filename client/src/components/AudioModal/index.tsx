import { Drawer, Empty, Modal } from 'antd';
import { useEffect, useState } from 'react';

import styles from './index.module.less';
import { inviteToCall } from './livekit-api';
import { LiveKitMedia } from './LiveKitMedia';
import { CallStatus, type ICallModalProps, type IRoomMembersItem } from './type';
import { CallIcons } from '@/assets/images';
import ImageLoad from '@/components/ImageLoad';
import useShowMessage from '@/hooks/useShowMessage';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import { formatCallTime } from '@/utils/time';

const AudioModal = ({ openmodal, handleModal, status, type, callInfo }: ICallModalProps) => {
	const showMessage = useShowMessage();
	const [callStatus, setCallStatus] = useState(status);
	const [duration, setDuration] = useState(0);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const { join, leave, participants, connectionState } = useLiveKitCall(callInfo.room, type, 'audio');
	const members: IRoomMembersItem[] = participants.map(item => ({ username: item.identity, muted: false }));
	const start = async () => {
		try {
			if (status === CallStatus.INITIATE) await inviteToCall(callInfo.room, type, type === 'private' ? 'private_audio' : 'group_audio');
			await join(); setCallStatus(CallStatus.CALLING);
		} catch { await leave(); showMessage('error', '无法连接语音通话，请检查 LiveKit 服务和设备权限'); handleModal(false); }
	};
	const hangup = async () => { await leave(); handleModal(false); showMessage('info', type === 'private' ? '已挂断通话' : '已退出群语音通话'); };
	useEffect(() => { if (status === CallStatus.INITIATE) void start(); }, []);
	useEffect(() => { if (callStatus !== CallStatus.CALLING) return; const id = setInterval(() => setDuration(value => value + 1), 1000); return () => clearInterval(id); }, [callStatus]);
	return <Modal open={openmodal} footer={null} wrapClassName="audioModal" width="5rem" title={`${type === 'private' ? '' : '群'}语音通话`} maskClosable={false} closable={type !== 'private'} onCancel={() => setDrawerOpen(true)}>
		<div className={styles.audioModalContent}><div className={styles.content}>
			<div className={styles.avatar}><ImageLoad src={type === 'private' ? callInfo.callReceiverList[0]?.avatar : CallIcons.AUDIO} /></div>
			{callStatus === CallStatus.INITIATE && <><span className={styles.callWords}>正在发起语音通话…</span><div className={styles.callIcons}><img src={CallIcons.REJECT} alt="挂断" onClick={hangup} /></div></>}
			{callStatus === CallStatus.RECEIVE && <><span className={styles.callWords}>{type === 'private' ? `${callInfo.callReceiverList[0]?.alias} 发起语音通话` : '有人邀请您加入群语音通话'}</span><div className={styles.callIcons}><img src={CallIcons.ACCEPT} alt="接听" onClick={() => void start()} /><img src={CallIcons.REJECT} alt="拒绝" onClick={hangup} /></div></>}
			{callStatus === CallStatus.CALLING && <><>{participants.map(item => <LiveKitMedia key={item.identity} track={item.audioTrack} />)}</><span className={styles.callWords}>{connectionState === 'connected' ? formatCallTime(duration) : '正在连接…'}</span><div className={styles.callIcons}><img src={CallIcons.REJECT} alt="挂断" onClick={hangup} /></div></>}
			{type === 'group' && <Drawer title="当前正在通话的群成员" placement="right" closable={false} onClose={() => setDrawerOpen(false)} open={drawerOpen} getContainer={false} width="50%" className="memberDrawer">{members.length ? members.map(member => <li key={member.username}>{member.username}</li>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无群友加入通话" />}</Drawer>}
		</div></div>
	</Modal>;
};
export default AudioModal;
