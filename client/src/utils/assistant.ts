// Front-end only assistant client. Calls a chat-completions compatible API (DeepSeek/OpenAI style).
// WARNING: Putting API keys in front-end exposes them to users. For production, proxy through your backend.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  model?: string;
  baseUrl?: string; // e.g., https://api.deepseek.com
  apiKey?: string; // Prefer VITE_ASSISTANT_API_KEY, fallback to VITE_DEEPSEEK_API_KEY
}

/**
 * 调用兼容 chat-completions 的 API（如 DeepSeek 或 OpenAI 风格）来获取聊天回复
 * 
 * @param messages - 聊天消息列表，每个消息包含角色和内容
 * @param opts - 可选配置项，包括模型名称、基础 URL 和 API 密钥
 * @returns 返回模型生成的回复内容字符串
 * 
 * @throws 当未提供 API 密钥时抛出 'no-api-key' 错误
 * @throws 当 API 请求失败时抛出包含状态码和错误信息的错误
 */
export async function chatCompletions(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  // 从环境变量中读取配置信息
  const env = ((import.meta as unknown) as { env: Record<string, string | undefined> }).env || {} as Record<string, string | undefined>;
  const apiKey = opts.apiKey || env.VITE_ASSISTANT_API_KEY || env.VITE_DEEPSEEK_API_KEY;
  const baseUrl = (opts.baseUrl || env.VITE_ASSISTANT_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = opts.model || env.VITE_ASSISTANT_MODEL || 'deepseek-chat';

  // 检查是否提供了 API 密钥
  if (!apiKey) {
    throw new Error('no-api-key');
  }

  // 发起 API 请求
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false
    })
  });

  // 处理 API 响应结果
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`chat-api ${resp.status} ${t}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return String(text);
}
