import dayjs from 'dayjs';

/**
 * 消息时间类型枚举
 * 用于区分消息发送时间与当前时间的关系
 */
export enum MessageType {
	/**
	 * 新消息
	 */
	NEW_MESSAGE = 1,
	
	/**
	 * 当天消息
	 */
	TODAY_MESSAGE,
	
	/**
	 * 昨天消息
	 */
	YESTERDAY_MESSAGE,
	
	/**
	 * 今年消息
	 */
	THIS_YEAR_MESSAGE,
	
	/**
	 * 其他消息
	 */
	OTHER_MESSAGE
}

/**
 * 判断消息类型
 * 根据传入的日期与当前时间的关系，确定消息属于哪种类型
 * @param date - 需要判断的日期
 * @returns 返回对应的消息类型枚举值
 */
const getDateDiff = (date: Date) => {
	const nowDate = dayjs(new Date()); // 当前时间
	const oldDate = dayjs(new Date(date)); // 参数时间
	let result;
	
	// 根据年份差异判断消息类型
	if (nowDate.year() - oldDate.year() >= 1) {
		result = MessageType.OTHER_MESSAGE;
		
	// 根据月份或日期差异判断是否为今年消息
	} else if (nowDate.month() - oldDate.month() >= 1 || nowDate.date() - oldDate.date() >= 2) {
		result = MessageType.THIS_YEAR_MESSAGE;
		
	// 判断是否为昨天的消息
	} else if (nowDate.date() - oldDate.date() >= 1) {
		result = MessageType.YESTERDAY_MESSAGE;
		
	// 判断是否为今天但超过5分钟的消息
	} else if (nowDate.hour() - oldDate.hour() >= 1 || nowDate.minute() - oldDate.minute() >= 5) {
		result = MessageType.TODAY_MESSAGE;
		
	// 5分钟内的新消息
	} else {
		result = MessageType.NEW_MESSAGE;
	}
	return result;
};

/**
 * 格式化时间 -- 用于聊天列表
 * 根据日期与当前时间的关系，返回不同格式的时间显示字符串
 * @param date - 需要格式化的日期
 * @returns 格式化后的时间字符串
 */
export const formatChatListTime = (date: Date) => {
	let time;
	const type = getDateDiff(date);
	
	// 根据不同类型返回相应的格式化时间
	switch (type) {
		case MessageType.NEW_MESSAGE:
			time = '刚刚'; // 新消息，不显示时间，但是要显示 "以下为最新消息"
			break;
		case MessageType.TODAY_MESSAGE:
			time = dayjs(date).format('H:mm'); // 当天消息，显示：10:22
			break;
		case MessageType.YESTERDAY_MESSAGE:
			time = '昨天'; // 昨天消息，显示：昨天
			break;
		case MessageType.THIS_YEAR_MESSAGE:
			time = dayjs(date).format('M月D日'); // 今年消息，显示：3月17日
			break;
		case MessageType.OTHER_MESSAGE:
			time = dayjs(date).format('YYYY年M月D日'); // 其他消息，显示：2020年11月2日
			break;
	}
	return time;
};

/**
 * 格式化时间 -- 用于聊天内容
 * 根据日期与当前时间的关系，返回不同格式的时间显示字符串，包含更详细的时间信息
 * @param date - 需要格式化的日期
 * @returns 格式化后的时间字符串
 */
export const formatChatContentTime = (date: Date) => {
	let time = '';
	const type = getDateDiff(date);
	
	// 根据不同类型返回相应的格式化时间
	switch (type) {
		case MessageType.NEW_MESSAGE:
			time = '刚刚'; // 新消息，不显示时间，但是要显示 "以下为最新消息"
			break;
		case MessageType.TODAY_MESSAGE:
			time = dayjs(date).format('H:mm'); // 当天消息，显示：10:22
			break;
		case MessageType.YESTERDAY_MESSAGE:
			time = dayjs(date).format('昨天 H:mm'); // 昨天消息，显示：昨天 20:41
			break;
		case MessageType.THIS_YEAR_MESSAGE:
			time = dayjs(date).format('M月D日 AH:mm').replace('AM', '上午').replace('PM', '下午'); // 今年消息，上午下午，显示：3月17日 下午16:45
			break;
		case MessageType.OTHER_MESSAGE:
			time = dayjs(date).format('YYYY年M月D日 AH:mm').replace('AM', '上午').replace('PM', '下午'); // 其他消息，上午下午，显示：2020年11月2日 下午15:17
			break;
	}
	return time;
};

/**
 * 格式化时间 -- 用于展示音视频通话时长
 * 将秒数转换为 HH:MM:SS 格式的字符串
 * @param duration - 通话时长（单位：秒）
 * @returns 格式化后的时长字符串（HH:MM:SS格式）
 */
export const formatCallTime = (duration: number) => {
	// 计算小时数并补零
	const hour =
		duration / 3600 < 10 ? '0' + Math.floor(duration / 3600) : Math.floor(duration / 3600);
	
	// 计算分钟数并补零
	const minute =
		(duration % 3600) / 60 < 10
			? '0' + Math.floor((duration % 3600) / 60)
			: Math.floor((duration % 3600) / 60);
	
	// 计算秒数并补零
	const second = duration % 60 < 10 ? '0' + Math.floor(duration % 60) : Math.floor(duration % 60);
	
	// 拼接最终的时间字符串
	const broadcastTime = hour + ':' + minute + ':' + second;
	return broadcastTime;
};