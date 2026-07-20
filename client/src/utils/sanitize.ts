/**
 * 漏洞2: 对 AI 返回内容做前端 sanitize
 * 移除 <script> 标签、on* 事件处理器和 javascript: 协议
 * 作为纵深防御，即使后端遗漏也能在前端兜底
 */
export const sanitizeAiContent = (text: string): string => {
	return String(text)
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
		.replace(/\son\w+\s*=\s*'[^']*'/gi, '')
		.replace(/javascript:/gi, '');
};
