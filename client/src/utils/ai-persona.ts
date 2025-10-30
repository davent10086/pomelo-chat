// 工具：设置/获取前端用于 AI 角色的人设信息（存储在 localStorage）
// 提供小而纯粹的 API 以便在多个页面复用，减少内联逻辑散落在页面组件中。
export function setAiPersona(name: string, prompt: string) {
	try {
		if (typeof window !== 'undefined') {
			localStorage.setItem('AI_PERSONA_PROMPT', prompt);
			localStorage.setItem('AI_PERSONA_NAME', name);
		}
	} catch (e) {
		// 忽略 localStorage 访问错误（无痕模式或受限环境）
		void e;
	}
}

export function clearAiPersona() {
	try {
		if (typeof window !== 'undefined') {
			localStorage.removeItem('AI_PERSONA_PROMPT');
			localStorage.removeItem('AI_PERSONA_NAME');
		}
	} catch (e) {
		void e;
	}
}
