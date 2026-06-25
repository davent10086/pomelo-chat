const express = require('express');
const router = express.Router();
const assistant = require('../../service/assistant/index');
const authenticate = require('../../utils/authenticate');

module.exports = () => {
	// 非流式聊天补全
	router.post('/chat', authenticate.authenticateToken, assistant.chat);
	// 流式聊天补全（SSE）
	router.post('/chat/stream', authenticate.authenticateToken, assistant.chatStream);
	// 下一步建议
	router.post('/next-steps', authenticate.authenticateToken, assistant.nextSteps);
	return router;
};
