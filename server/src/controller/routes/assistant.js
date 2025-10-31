const express = require('express');
const router = express.Router();
const assistant = require('../../service/assistant/index');
const authenticate = require('../../utils/authenticate');

module.exports = () => {
  // 代理 AI 聊天：接收用户消息，调用后端大模型（使用服务器上的密钥），
  // 并把用户消息与 AI 回复持久化到 message 表中
  router.post('/chat', authenticate.authenticateTokenOptional, assistant.chat);

  // 清空某个 ai 房间的聊天记录（用于“清空聊天记录”按钮）
  router.delete('/history', authenticate.authenticateTokenOptional, assistant.clearHistory);

  return router;
};
