// 1xx 开头的状态码用于 通用 模块
export const CommonStatus = {
	SERVER_ERR: 1001,
	TOKEN_ERR: 1002,
	PARAM_ERR: 1003,
	CREATE_ERR: 1004,
	UPDATE_ERR: 1005,
	UNAUTHORIZED: 1006,
	NOT_FOUND: 1007,
	CONNECTION_ERR: 1008
} as const;

const CommonStatusMap: Record<number, string> = {
	1001: '服务有误',
	1002: 'Token 错误或过期',
	1003: '参数错误',
	1004: '创建失败',
	1005: '修改失败',
	1006: '未授权，请重新登录',
	1007: '资源不存在',
	1008: '连接失败'
};

// 2xx 开头的状态码用于 auth 模块
export const AuthStatus = {
	USER_OR_PASS_ERR: 2001,
	USER_ALREADY_LOGGEDIN: 2002,
	USER_EXIT_ERR: 2003,
	USER_NOTEXIT_ERR: 2004,
	PHONE_EXIT_ERR: 2005
} as const;

const AuthStatusMap: Record<number, string> = {
	2001: '用户名或密码错误',
	2002: '用户已登录',
	2003: '用户名或手机号已注册',
	2004: '用户名与手机号不匹配',
	2005: '该手机号已被绑定'
};

// 3xx 开头的状态码用于 friend 模块
export const FriendStatus = {
	FRIEND_EXIST: 3001,
	FRIEND_NOT_EXIST: 3002,
	FRIEND_ALREADY_ADDED: 3003,
	FRIEND_SELF: 3004
} as const;

const FriendStatusMap: Record<number, string> = {
	3001: '好友已存在',
	3002: '好友不存在',
	3003: '该用户已是你的好友',
	3004: '不能添加自己为好友'
};

// 4xx 开头的状态码用于 group 模块
export const GroupStatus = {
	ALL_EXIT_ERR: 4001,
	EXIT_GROUP_ERR: 4002,
	GROUP_NOT_EXIST: 4003,
	GROUP_PERMISSION_ERR: 4004
} as const;

const GroupStatusMap: Record<number, string> = {
	4001: '你邀请的好友都已经加入群聊',
	4002: '你已加入群聊',
	4003: '群聊不存在',
	4004: '无权限操作该群聊'
};

// 5xx 开头的状态码用于 message 模块
export const MessageStatus = {
	MESSAGE_SEND_ERR: 5001,
	MESSAGE_WS_ERR: 5002,
	ROOM_PARAM_ERR: 5003,
	MESSAGE_HISTORY_ERR: 5004
} as const;

const MessageStatusMap: Record<number, string> = {
	5001: '消息发送失败',
	5002: '消息通道连接失败',
	5003: '房间参数错误',
	5004: '获取历史消息失败'
};

// 6xx 开头的状态码用于 file 模块
export const FileStatus = {
	FILE_EXIST: 6001,
	ALL_CHUNK_UPLOAD: 6002,
	FILE_TOO_LARGE: 6003,
	FILE_TYPE_ERR: 6004,
	FILE_UPLOAD_ERR: 6005
} as const;

const FileStatusMap: Record<number, string> = {
	6001: '该文件已被上传',
	6002: '已完成所有分片上传，请合并文件',
	6003: '文件大小超出限制',
	6004: '不支持的文件类型',
	6005: '文件上传失败'
};

// 7xx 开头的状态码用于 RTC 模块
export const RtcStatus = {
	RTC_ROOM_ERR: 7001,
	RTC_CALL_ERR: 7002
} as const;

const RtcStatusMap: Record<number, string> = {
	7001: '音视频房间创建失败',
	7002: '通话发起失败'
};

// 8xx 开头的状态码用于 assistant 模块
export const AssistantStatus = {
	RATE_LIMIT_ERR: 8001,
	CONTENT_TOO_LONG: 8002,
	INVALID_MESSAGE: 8003,
	UPSTREAM_TIMEOUT: 8004
} as const;

const AssistantStatusMap: Record<number, string> = {
	8001: '请求过于频繁，请稍后再试',
	8002: '消息内容过长，请精简后重试',
	8003: '消息格式不合法',
	8004: 'AI 服务响应超时，请稍后重试'
};

// 合并所有的状态码
export const StatusMap: Record<number, string> = {
	...AuthStatusMap,
	...GroupStatusMap,
	...CommonStatusMap,
	...FileStatusMap,
	...FriendStatusMap,
	...MessageStatusMap,
	...RtcStatusMap,
	...AssistantStatusMap
};

export const SUCCESS_CODE = 200;
