import { Router } from 'express';
import { assistantHttp as assistant } from '../../composition';
import { assistantHttp as assistantAgent } from '../../composition';
import { agentStream } from '../../modules/assistant/agent-http';
import { assistantHttp as assistantActions } from '../../composition';
import { chatStream } from '../../modules/assistant/legacy-http';
import { authenticateToken } from '../../modules/identity/middleware';

const router = Router();

export default () => {
	// 非流式聊天补全
	router.post('/chat', authenticateToken, assistant.chat);
	// 流式聊天补全（SSE）
	router.post('/chat/stream', authenticateToken, chatStream);
	// 下一步建议
	router.post('/next-steps', authenticateToken, assistant.nextSteps);
	// LangChain 聊天 Agent
	router.post('/agent', authenticateToken, assistantAgent.agentChat);
	router.post('/agent/stream', authenticateToken, agentStream);
	router.get('/agent/tools', authenticateToken, assistantAgent.listAgentTools);
	router.post('/agent/tools/call', authenticateToken, assistantAgent.callAgentTool);
	router.post('/agent/task-candidates', authenticateToken, assistantAgent.taskCandidates);
	router.post('/actions/confirm', authenticateToken, assistantActions.confirmAction);
	router.post('/actions/cancel', authenticateToken, assistantActions.cancelAction);
	router.get('/actions/:id', authenticateToken, assistantActions.getActionStatus);
	router.get('/tasks', authenticateToken, assistantActions.listTasks);
	router.patch('/tasks/:id', authenticateToken, assistantActions.updateTask);
	return router;
};
