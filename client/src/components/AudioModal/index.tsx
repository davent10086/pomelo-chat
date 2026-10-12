import { Drawer, Empty, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';

import styles from './index.module.less';
import { inviteToCall, acceptCall, endCall } from './livekit-api';
import { LiveKitMedia } from './LiveKitMedia';
import { CallStatus, type ICallModalProps, type IRoomMembersItem } from './type';
import { CallIcons } from '@/assets/images';
import ImageLoad from '@/components/ImageLoad';
import useShowMessage from '@/hooks/useShowMessage';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import { formatCallTime } from '@/utils/time';

const AudioModal = ({ openmodal, handleModal, status, type, callInfo }: ICallModalProps) => {
	const showMessage = useShowMessage();
	const callId = useRef(callInfo.callId);
	const pending = useRef(false);
	const disposed = useRef(false);
	const accepted = useRef(false);
	const [callStatus, setCallStatus] = useState(status);
	const [duration, setDuration] = useState(0);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const { join, leave, participants, connectionState } = useLiveKitCall(callInfo.room, type, 'audio');
	const members: IRoomMembersItem[] = participants.map(item => ({ username: item.identity, muted: false }));
 const start = async () => {
  if (pending.current) return;
  pending.current = true;
  try {
   if (status === CallStatus.INITIATE) {
    const response = await inviteToCall(callInfo.room,type,type === 'private' ? 'private_audio' : 'group_audio');
    callId.current = response.data.data.callId;
    if (disposed.current) { await endCall(callId.current); return; }
   } else {
    if (!callId.current) throw new Error('Missing call id');
    await acceptCall(callId.current); accepted.current = true;
   }
   await join(callId.current!);
   if (!disposed.current && status !== CallStatus.INITIATE) setCallStatus(CallStatus.CALLING);
  } catch { if (callId.current) await endCall(callId.current).catch(() => undefined); await leave(); if (!disposed.current) {showMessage('error','无法连接通话，请检查服务和设备权限'); handleModal(false);} }
  finally { pending.current = false; }
 };
 const hangup = async () => { disposed.current = true; if (callId.current) await endCall(callId.current).catch(() => undefined); await leave(); handleModal(false); };
 useEffect(() => {
  const handler = (event: Event) => {
   const state = (event as CustomEvent<{callId: string; status: string; memberStatus?: string}>).detail;
   if (state.callId !== callId.current) return;
   if (state.status === 'ended' || state.memberStatus === 'left') { void hangup(); }
   else if (state.status === 'active' && state.memberStatus === 'joined') { accepted.current = true; setCallStatus(CallStatus.CALLING); }
  };
  window.addEventListener('pomelo-call-state',handler);
  const disconnected = (event: Event) => {if ((event as CustomEvent<{callId: string}>).detail.callId === callId.current) void hangup();};
  window.addEventListener('pomelo-call-disconnected',disconnected);
  const timeout = setTimeout(() => { if (!accepted.current) void hangup(); },45000);
  if (status === CallStatus.INITIATE) void start();
  return () => { disposed.current = true; clearTimeout(timeout); window.removeEventListener('pomelo-call-state',handler); window.removeEventListener('pomelo-call-disconnected',disconnected); if (callId.current) void endCall(callId.current).catch(() => undefined); };
 },[]);
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
