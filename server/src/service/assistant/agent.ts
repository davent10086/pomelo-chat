export {normalizeAgentRequest, validateTaskCandidateSources} from '../../modules/assistant/agent';
export {agentStream} from '../../modules/assistant/agent-http';
import {assistantHttp} from '../../composition';
export const {agentChat,listAgentTools,callAgentTool,taskCandidates} = assistantHttp;
