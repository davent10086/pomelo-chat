import { assistantHttp } from '../../composition';
export const { confirmAction, getActionStatus, cancelAction, listTasks, updateTask } = assistantHttp;
export { chatStream } from '../../modules/assistant/legacy-http';
export const { chat, nextSteps } = assistantHttp;
