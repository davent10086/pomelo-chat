import { SmileOutlined, PictureOutlined, FolderOutlined, PhoneOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { Button, Spin, Tooltip } from 'antd';
import React, { ChangeEvent, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

import { getGroupMembers } from './api';
import styles from './index.module.less';
import { useChatDraft } from './useChatDraft';
import NextStepSuggestions from './NextStepSuggestions';
import { ChatToolHandle, IChatToolProps, IMessageListItem, ISendMessage } from './type';

import { EmojiList } from '@/assets/emoji';
import { ChatIconList } from '@/assets/icons';
import AudioModal from '@/components/AudioModal';
import { ICallReceiverInfo } from '@/components/AudioModal/type';
import VideoModal from '@/components/VideoModal';
import useShowMessage from '@/hooks/useShowMessage';
import { HttpStatus } from '@/utils/constant';
import { getFileSuffixByName } from '@/utils/File';
import { uploadFile } from '@/utils/file-upload';
import { useReplySuggestions } from '@/hooks/useReplySuggestions';
import { tokenStorage, userStorage } from '@/utils/storage';

const toolIcons: Record<string, React.ReactNode> = { 'icon-biaoqing': <SmileOutlined />, 'icon-tupian_huaban': <PictureOutlined />, 'icon-wenjian1': <FolderOutlined />, 'icon-dianhua': <PhoneOutlined />, 'icon-video': <VideoCameraOutlined /> };

const ChatTool = forwardRef<ChatToolHandle, IChatToolProps>((props, ref) => {
	const { curChatInfo, sendMessage, recentMessages = [], userProfile, externalInsertText } = props;
	// H11: userStorage.getItem() 已返回对象
	const user = userProfile && Object.keys(userProfile).length ? userProfile : userStorage.getItem();
	const showMessage = useShowMessage();
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const insertionCursor = useRef<number>();
	const {
		text: inputValue,
		setValue: setInputValue,
		saveSelection,
		clearSent
	} = useChatDraft(Number(user.id), curChatInfo.room, textareaRef);
	const [loading, setLoading] = useState(false);
	const [uploadStatus, setUploadStatus] = useState('');
	const uploading = useRef(false);
	const sendingText = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	const [openAudioModal, setAudioModal] = useState(false);
	const [openVideoModal, setVideoModal] = useState(false);
	const [callReceiverList, setCallReceiverList] = useState<ICallReceiverInfo[]>([]);
	const imageRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const {
		suggestions,
		loading: suggestionsLoading,
		refresh,
		cancel
	} = useReplySuggestions(recentMessages, {
		scope: `${user.id}:${curChatInfo.room}`
	});
	const [selectedIndex, setSelectedIndex] = useState(-1);
	const showSuggestions = suggestions.length > 0;
	const previewText = suggestions[selectedIndex] || '';
	const cancelSuggestions = () => {
		cancel();
		setSelectedIndex(-1);
	};

	const changeInputValue = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		cancelSuggestions();
		setInputValue(e.target.value);
	};
	const addEmoji = (emoji: string) => {
		cancelSuggestions();
		setInputValue(prev => prev + emoji);
	};

	const insertTextAtCursor = (text: string) => {
		if (!text) return;
		const { start, end } = getCursor();
		insertionCursor.current = start + text.length;
		setInputValue(previous => previous.slice(0, start) + text + previous.slice(end));
	};
	useLayoutEffect(() => {
		const position = insertionCursor.current;
		const element = textareaRef.current;
		if (position === undefined || !element) return;
		insertionCursor.current = undefined;
		element.focus();
		element.setSelectionRange(position, position);
		saveSelection();
	}, [inputValue, saveSelection]);

	const triggerSuggestions = async (prefix: string) => {
		setSelectedIndex(-1);
		const items = await refresh(prefix);
		if (items.length) setSelectedIndex(0);
	};

	const getCursor = () => {
		const el = textareaRef.current!;
		return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
	};

	const handleSuggestionClick = (text: string) => {
		insertTextAtCursor(text);
		cancelSuggestions();
	};

	useEffect(() => {
		if (externalInsertText?.text) {
			insertTextAtCursor(externalInsertText.text);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [externalInsertText?.id]);

	const acceptSuggestion = () => {
		if (previewText) handleSuggestionClick(previewText);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Tab') {
			e.preventDefault();
			if (showSuggestions && suggestions.length) {
				const next = (selectedIndex + 1) % suggestions.length;
				setSelectedIndex(next);
				return;
			}
			const el = textareaRef.current!;
			const start = el.selectionStart ?? 0;
			const prefix = inputValue.slice(0, start);
			triggerSuggestions(prefix);
		} else if (e.key === 'Escape') {
			if (showSuggestions || suggestionsLoading) {
				e.preventDefault();
				cancelSuggestions();
			}
		} else if ((e.key === 'ArrowRight' || e.key === 'Enter') && showSuggestions && previewText) {
			e.preventDefault();
			acceptSuggestion();
		} else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void handleSendTextMessage();
		} else if (e.key === 'ArrowDown' && showSuggestions) {
			e.preventDefault();
			setSelectedIndex(prev => Math.min(suggestions.length - 1, prev + 1));
		} else if (e.key === 'ArrowUp' && showSuggestions) {
			e.preventDefault();
			setSelectedIndex(prev => Math.max(0, prev - 1));
		}
	};

	const handleSendTextMessage = async () => {
		if (!inputValue.trim() || loading || sendingText.current) return;
		sendingText.current = true;
		const sentText = inputValue;
		let accepted = false;
		const onAccepted = () => {
			if (accepted) return;
			accepted = true;
			clearSent(sentText);
			cancelSuggestions();
		};
		try {
			const newmessage: ISendMessage = {
				sender_id: user.id,
				receiver_id: curChatInfo.receiver_id,
				type: 'text',
				content: inputValue,
				avatar: user.avatar
			};
			await sendMessage(newmessage, onAccepted);
			if (!accepted) onAccepted();
		} catch {
			showMessage('error', '消息发送失败，请重试');
		} finally {
			sendingText.current = false;
		}
	};

	const handleSendFiles = async (files: File[]) => {
		if (!files.length) return;
		if (curChatInfo.room.startsWith('ai_')) { showMessage('warning', '请在私聊或群聊中发送文件'); return; }
		if (uploading.current) { showMessage('info', '正在上传文件，请稍后再试'); return; }
		if (files.length > 10) { showMessage('warning', '一次最多发送 10 个文件'); return; }
		const token = tokenStorage.getItem();
		const current = () => mounted.current && tokenStorage.getItem() === token && Number(userStorage.getItem().id) === Number(user.id);
		uploading.current = true; setLoading(true);
		try {
			for (const [index, file] of files.entries()) {
				if (!current()) break;
				if (file.size <= 0 || file.size > 100 * 1024 * 1024) {
					showMessage('warning', `${file.name}：文件大小需在 1B 到 100MB 之间`); continue;
				}
				setUploadStatus(`正在上传 ${index + 1}/${files.length}：${file.name}`);
				try {
					const res = await uploadFile(file, 5, undefined, undefined, progress => {
						if (current()) setUploadStatus(`正在上传 ${index + 1}/${files.length}：${file.name} (${progress}%)`);
					});
					// A late upload must never send through a newly selected conversation or account.
					if (!current()) break;
					if (!res.success || !res.filePath) throw new Error('文件上传失败');
					await sendMessage({ sender_id: user.id, receiver_id: curChatInfo.receiver_id,
						type: getFileSuffixByName(file.name), content: res.filePath, avatar: user.avatar, fileSize: file.size, fileName: file.name });
				} catch {
					if (current()) showMessage('error', `${file.name}：上传或发送失败，请重试`);
				}
			}
		} finally {
			uploading.current = false;
			if (mounted.current) { setLoading(false); setUploadStatus(''); }
		}
	};
	useImperativeHandle(ref, () => ({ sendFiles: handleSendFiles }));
	const handleSendFileMessage = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files || []);
		event.target.value = '';
		void handleSendFiles(files);
	};

	const handleAudioModal = (visible: boolean) => setAudioModal(visible);
	const handleVideoModal = (visible: boolean) => setVideoModal(visible);

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

	const emojiList = (
			<div className={styles.emoji_list}>
				{EmojiList.map(item => (
					<button
						type="button"
						key={item}
						className={styles.emoji_item}
						onClick={() => addEmoji(item)}
						aria-label={`插入表情 ${item}`}
					>
						{item}
					</button>
				))}
			</div>
	);

	const isGroupChat = (item: IMessageListItem) => !item.receiver_username;

	const getCallReceiverList = async () => {
		if (isGroupChat(curChatInfo)) {
			try {
				const params = { groupId: curChatInfo.receiver_id, room: curChatInfo.room };
				const res = await getGroupMembers(params);
				if (res.code === HttpStatus.SUCCESS && res.data) {
					setCallReceiverList(
						res.data.map(item => ({
							username: item.username,
							alias: item.nickname,
							avatar: item.avatar
						}))
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
					{ChatIconList.slice(0, 3).map((item, index) => (
						<Tooltip
							key={item.text}
							placement={index === 0 ? 'top' : 'bottomLeft'}
							title={index === 0 ? emojiList : item.text}
							arrow={false}
						>
							<button
								type="button"
								className={styles.toolIcon}
								aria-label={item.text}
								onClick={() => {
									if (item.icon !== 'icon-biaoqing') {
										handleIconClick(item.icon);
									}
								}}
							>{toolIcons[item.icon]}</button>
						</Tooltip>
					))}
					<NextStepSuggestions messages={recentMessages} scope={`${user.id}:${curChatInfo.room}`} onInsert={handleSuggestionClick} />
				</ul>
				<ul className={styles.rightIcons}>
					{ChatIconList.slice(3, 6).map(item => (
						<Tooltip key={item.text} placement="bottomLeft" title={item.text} arrow={false}>
							<button
								type="button"
								className={styles.toolIcon}
								aria-label={item.text}
								onClick={() => handleIconClick(item.icon)}
							>{toolIcons[item.icon]}</button>
						</Tooltip>
					))}
				</ul>
				<input
					type="file"
					multiple
					accept="image/*,video/*"
					style={{ display: 'none' }}
					ref={imageRef}
					onChange={e => handleSendFileMessage(e)}
				/>
				<input
					type="file"
					multiple
					accept="*"
					style={{ display: 'none' }}
					ref={fileRef}
					onChange={e => handleSendFileMessage(e)}
				/>
			</div>
			<div className={styles.chat_tool_input}>
				<Spin spinning={loading} tip={uploadStatus || '正在发送中...'}>
					<textarea
						ref={textareaRef}
						onChange={e => changeInputValue(e)}
						onKeyDown={handleKeyDown}
						onSelect={saveSelection}
						onBlur={saveSelection}
						value={inputValue}
						placeholder="输入消息，Enter 发送，Shift + Enter 换行"
						aria-label="消息输入框"
					></textarea>
				</Spin>
			</div>
			<div className={styles.chat_tool_btn}>
				<Button type="primary" disabled={loading} onClick={handleSendTextMessage}>
					发送
				</Button>
			</div>
			{showSuggestions && suggestions.length > 0 && (
				<div className={styles.suggestionBox}>
					<div className={styles.suggestionHeader}>
						<span className={styles.suggestionTitle}>候选回复</span>
						<button
							type="button"
							className={styles.closeBtn}
							onClick={cancelSuggestions}
							aria-label="关闭候选回复"
						>
							×
						</button>
					</div>
					<ul>
						{suggestions.map((s, idx) => (
							<button
								type="button"
								key={idx}
								className={idx === selectedIndex ? styles.selected : ''}
								onClick={() => handleSuggestionClick(s)}
							>
								{s}
							</button>
						))}
					</ul>
					<div className={styles.preview}>{previewText}</div>
				</div>
			)}
			{openAudioModal && callReceiverList.length && (
				<AudioModal
					openmodal={openAudioModal}
					handleModal={handleAudioModal}
					status="initiate"
					type={isGroupChat(curChatInfo) ? 'group' : 'private'}
					callInfo={{ room: curChatInfo.room, callReceiverList }}
				/>
			)}
			{openVideoModal && callReceiverList.length && (
				<VideoModal
					openmodal={openVideoModal}
					handleModal={handleVideoModal}
					status="initiate"
					type={isGroupChat(curChatInfo) ? 'group' : 'private'}
					callInfo={{ room: curChatInfo.room, callReceiverList }}
				/>
			)}
		</div>
	);
});
ChatTool.displayName = 'ChatTool';

export default ChatTool;
