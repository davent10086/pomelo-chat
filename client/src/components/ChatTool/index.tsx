import { Button, Spin, Tooltip } from 'antd';
import React, { ChangeEvent, useEffect, useRef, useState } from 'react';

import { getGroupMembers } from './api';
import styles from './index.module.less';
import { IChatToolProps, IMessageListItem, ISendMessage } from './type';

import { EmojiList } from '@/assets/emoji';
import { ChatIconList } from '@/assets/icons';
import AudioModal from '@/components/AudioModal';
import { ICallReceiverInfo } from '@/components/AudioModal/type';
import VideoModal from '@/components/VideoModal';
import useShowMessage from '@/hooks/useShowMessage';
import { HttpStatus } from '@/utils/constant';
import { getFileSuffixByName } from '@/utils/File';
import { uploadFile } from '@/utils/file-upload';
import { userStorage } from '@/utils/storage';

const ChatTool = (props: IChatToolProps) => {
	const { curChatInfo, sendMessage, recentMessages = [], userProfile = {} } = props;
	// 既有 userStorage 作为当前用户信息备用
	const user = userProfile && Object.keys(userProfile).length ? userProfile : JSON.parse(userStorage.getItem());
	const showMessage = useShowMessage();
	const [inputValue, setInputValue] = useState<string>('');
	const [loading, setLoading] = useState(false);
	const [openAudioModal, setAudioModal] = useState(false);
	const [openVideoModal, setVideoModal] = useState(false);
	const [callReceiverList, setCallReceiverList] = useState<ICallReceiverInfo[]>([]); // 音视频通话对象列表
	const imageRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	// 备注：已移除“分析文件”能力，仅保留对话

	// --- AI Tab 补全 / 建议状态（前端实现，无需修改服务端）
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [selectedIndex, setSelectedIndex] = useState<number>(-1);
	const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
	const [previewText, setPreviewText] = useState<string>('');
	const suggestionFetchAbort = useRef<AbortController | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	// ---- AI suggestion helpers (component scope) ----
	const buildContextText = (limit = 10) => {
		const msgs = recentMessages || [];
		const last = msgs.slice(Math.max(0, msgs.length - limit));
		return last
			.map((m: { sender_name?: string; content?: string }) => `${m.sender_name || '用户'}: ${m.content || ''}`)
			.join('\n');
	};

	const heuristicSuggestions = (prefix: string, count = 3) => {
		const lastMsg =
			recentMessages && recentMessages.length
				? ((recentMessages[recentMessages.length - 1] as { content?: string }).content || '')
				: '';
		const userPref = (user && (user as { pref?: string }).pref) || '';
		const base = lastMsg || prefix || '关于这个话题';
		const items = [
			`${base}，我觉得可以这样说：`,
			`关于${base}，可以考虑：...`,
			`${base}，我的建议是：` + (userPref ? `（偏好：${userPref}）` : '')
		];
		return items.slice(0, count);
	};

	// 改变输入框的值
	const changeInputValue = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setInputValue(e.target.value);
		// 输入时清理建议
		if (showSuggestions) {
			setShowSuggestions(false);
			setSuggestions([]);
			setSelectedIndex(-1);
			setPreviewText('');
			if (suggestionFetchAbort.current) {
				suggestionFetchAbort.current.abort();
				suggestionFetchAbort.current = null;
			}
		}
	};

	// 添加表情
	const addEmoji = (emoji: string) => {
		setInputValue(prevValue => prevValue + emoji);
	};

	const insertTextAtCursor = (text: string) => {
		if (!text) return;
		const el = textareaRef.current!;
		const { start, end } = getCursor();
		const newVal = inputValue.slice(0, start) + text + inputValue.slice(end);
		setInputValue(newVal);
		const newPos = start + text.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(newPos, newPos);
		});
	};

	// 来自 ChatContainer 的“下一步建议”插入事件
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent<{ text: string }>).detail;
			if (detail?.text) insertTextAtCursor(detail.text);
		};
		window.addEventListener('next-steps-insert', handler as EventListener);
		return () => window.removeEventListener('next-steps-insert', handler as EventListener);
	}, [inputValue]);

	const fetchSuggestionsFromDeepSeek = async (prefixText: string) => {
		const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
		if (!apiKey) throw new Error('no-deepseek-key');
		if (suggestionFetchAbort.current) suggestionFetchAbort.current.abort();
		const controller = new AbortController();
		suggestionFetchAbort.current = controller;

		const prompt = `基于下面的对话历史，给出最多5条可作为回复或继续对话的短语（简洁，中文，每条不超过50字），并根据用户画像风格适当调整：\n\n对话历史：\n${buildContextText(10)}\n\n当前输入片段：\n${prefixText}\n\n返回格式：用换行分隔列出候选。`;

		const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			signal: controller.signal,
			body: JSON.stringify({
				model: 'deepseek-chat',
				messages: [
					{ role: 'system', content: '你是一个用于生成对话回复候选的助手，输出简单的候选列表，每行一项。' },
					{ role: 'user', content: prompt }
				],
				stream: false
			})
		});

		if (!resp.ok) {
			const t = await resp.text();
			throw new Error(`deepseek error ${resp.status} ${t}`);
		}
		const data = await resp.json();
		const text = data?.choices?.[0]?.message?.content || '';
		const lines = text.split('\n').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
		return lines.slice(0, 5);
	};

	const triggerSuggestions = async (prefixText: string) => {
		setShowSuggestions(false);
		setSuggestions([]);
		setSelectedIndex(-1);
		setPreviewText('');
		try {
			let items: string[] = [];
			try {
				items = await fetchSuggestionsFromDeepSeek(prefixText);
			} catch (err) {
				items = heuristicSuggestions(prefixText, 5);
			}
			if (items && items.length) {
				setSuggestions(items);
				setSelectedIndex(0);
				setShowSuggestions(true);
				setPreviewText(items[0]);
			}
		} catch (err) {
			showMessage('error', '生成建议失败');
		}
	};

	const cancelSuggestions = () => {
		if (suggestionFetchAbort.current) {
			suggestionFetchAbort.current.abort();
			suggestionFetchAbort.current = null;
		}
		setShowSuggestions(false);
		setSuggestions([]);
		setSelectedIndex(-1);
		setPreviewText('');
	};

	// 获取光标位置
	const getCursor = () => {
		const el = textareaRef.current!;
		return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
	};

	// 点击建议项插入文本
	const handleSuggestionClick = (text: string) => {
		if (!text) return;
		const el = textareaRef.current!;
		const { start, end } = getCursor();
		const newVal = inputValue.slice(0, start) + text + inputValue.slice(end);
		setInputValue(newVal);
		setShowSuggestions(false);
		setSuggestions([]);
		setSelectedIndex(-1);
		setPreviewText('');
		const newPos = start + text.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(newPos, newPos);
		});
	};

	useEffect(() => {
		return () => {
			if (suggestionFetchAbort.current) {
				suggestionFetchAbort.current.abort();
				suggestionFetchAbort.current = null;
			}
		};
	}, []);

	const acceptSuggestion = () => {
		if (!previewText) return;
		const el = textareaRef.current!;
		const { start, end } = getCursor();
		const newVal = inputValue.slice(0, start) + previewText + inputValue.slice(end);
		setInputValue(newVal);
		// reset
		setShowSuggestions(false);
		setSuggestions([]);
		setSelectedIndex(-1);
		setPreviewText('');
		const newPos = start + previewText.length;
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(newPos, newPos);
		});
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
			if (showSuggestions) {
				e.preventDefault();
				cancelSuggestions();
			}
		} else if ((e.key === 'ArrowRight' || e.key === 'Enter') && showSuggestions && previewText) {
			e.preventDefault();
			acceptSuggestion();
		} else if (e.key === 'ArrowDown' && showSuggestions) {
			e.preventDefault();
			setSelectedIndex(prev => Math.min(suggestions.length - 1, prev + 1));
		} else if (e.key === 'ArrowUp' && showSuggestions) {
			e.preventDefault();
			setSelectedIndex(prev => Math.max(0, prev - 1));
		}
	};

	// 发送编辑的文本消息
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

	// 发送图片/视频/文件消息：先进行文件上传的逻辑获取文件的 URL，然后再发送消息
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
							type: getFileSuffixByName(file.name),
							content: res.filePath,
							avatar: user.avatar,
							fileSize: file.size
						};
						sendMessage(newmessage);
					} catch (error) {
						showMessage('error', '消息发送失败，请重试');
					}
				} else {
					showMessage('error', '文件上传失败，请重试');
				}
			} catch (error) {
				showMessage('error', '文件上传失败，请重试');
			} finally {
				setLoading(false);
				imageRef.current!.value = '';
				fileRef.current!.value = '';
			}
		}
	};

	// （已移除文件分析处理函数）

	// 控制音频通话弹窗的显隐
	const handleAudioModal = (visible: boolean) => {
		setAudioModal(visible);
	};

	// 控制视频通话弹窗的显隐
	const handleVideoModal = (visible: boolean) => {
		setVideoModal(visible);
	};

	// 点击不同的图标产生的回调
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

	// 判断当前的聊天是否为群聊
	const isGroupChat = (item: IMessageListItem) => {
		return !item.receiver_username;
	};

	// 获取当前聊天对象的信息（群友信息或者好友信息），用于音视频通话
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
										if (item.icon === 'icon-biaoqing') {
											// 表情图标已通过title属性处理
										} else {
											handleIconClick(item.icon);
										}
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
						ref={textareaRef}
						onChange={e => {
							changeInputValue(e);
						}}
						onKeyDown={handleKeyDown}
						value={inputValue}
					></textarea>
				</Spin>
			</div>
			<div className={styles.chat_tool_btn}>
				<Button type="primary" onClick={handleSendTextMessage}>
					发送
				</Button>
			</div>
			{/* 建议面板（简易） */}
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
							<li
								key={idx}
								className={idx === selectedIndex ? styles.selected : ''}
								onClick={() => handleSuggestionClick(s)}
							>
								{s}
							</li>
						))}
					</ul>
					<div className={styles.preview}>{previewText}</div>
				</div>
			)}
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