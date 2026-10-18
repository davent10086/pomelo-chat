import { Router } from 'express';
import { assistantHttp as assistant } from '../../composition';
import { agentStream } from '../../modules/assistant/agent-http';
import { authenticateToken } from '../../modules/identity/middleware';

const router = Router();

export default () => {
	// LangChain 聊天 Agent
	router.post('/agent', authenticateToken, assistant.agentChat);
	router.post('/agent/stream', authenticateToken, agentStream);
	router.get('/agent/tools', authenticateToken, assistant.listAgentTools);
	router.post('/agent/tools/call', authenticateToken, assistant.callAgentTool);
	router.post('/agent/task-candidates', authenticateToken, assistant.taskCandidates);
	router.post('/actions/confirm', authenticateToken, assistant.confirmAction);
	router.post('/actions/message-draft', authenticateToken, assistant.prepareMessage);
	router.post('/actions/cancel', authenticateToken, assistant.cancelAction);
	router.get('/actions/:id', authenticateToken, assistant.getActionStatus);
	router.get('/tasks', authenticateToken, assistant.listTasks);
	router.patch('/tasks/:id', authenticateToken, assistant.updateTask);
	return router;
};
