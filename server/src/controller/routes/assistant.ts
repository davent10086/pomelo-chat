import { Router } from 'express';
import * as assistant from '../../service/assistant';
import * as assistantAgent from '../../service/assistant/agent';
import { authenticateToken } from '../../utils/authenticate';

const router = Router();

export default () => {
	// 非流式聊天补全
	router.post('/chat', authenticateToken, assistant.chat);
	// 流式聊天补全（SSE）
	router.post('/chat/stream', authenticateToken, assistant.chatStream);
	// 下一步建议
	router.post('/next-steps', authenticateToken, assistant.nextSteps);
	// LangChain 聊天 Agent
	router.post('/agent', authenticateToken, assistantAgent.agentChat);
	router.post('/agent/stream', authenticateToken, assistantAgent.agentStream);
	router.get('/agent/tools', authenticateToken, assistantAgent.listAgentTools);
	router.post('/agent/tools/call', authenticateToken, assistantAgent.callAgentTool);
	return router;
};
