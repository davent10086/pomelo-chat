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

export async function chatCompletions(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const env = ((import.meta as unknown) as { env: Record<string, string | undefined> }).env || {} as Record<string, string | undefined>;
  const apiKey = opts.apiKey || env.VITE_ASSISTANT_API_KEY || env.VITE_DEEPSEEK_API_KEY;
  const baseUrl = (opts.baseUrl || env.VITE_ASSISTANT_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = opts.model || env.VITE_ASSISTANT_MODEL || 'deepseek-chat';

  // 优先使用前端配置的 Key；如果没有暴露给前端，则通过后端代理调用（避免泄露 Key）
  if (apiKey) {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: false })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`chat-api ${resp.status} ${t}`);
    }
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return String(text);
  }

  // 无前端 Key：使用后端代理接口（后端负责使用安全的 Key 调用第三方模型并持久化历史）
  // 后端接口：POST /api/chat/v1/assistant/chat
  // 请求体：{ room, user_id, content, persona? }
  // 为兼容现有调用，我们从 messages 中提取最后一条 user 消息作为 content
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const content = lastUser ? lastUser.content : messages[messages.length - 1].content;
  // room 和 user_id 需要调用方在 opts 中传入（Chat 页会提供）
  const proxyBody: any = { content };
  if ((opts as any).room) proxyBody.room = (opts as any).room;
  if ((opts as any).user_id) proxyBody.user_id = (opts as any).user_id;
  if ((opts as any).persona) proxyBody.persona = (opts as any).persona;

  const resp = await fetch('/api/chat/v1/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proxyBody)
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`assistant-proxy ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return String(data?.data?.reply || data?.reply || '');
}

export async function clearAiHistory(room: string) {
  if (!room) throw new Error('room required');
  const resp = await fetch(`/api/chat/v1/assistant/history?room=${encodeURIComponent(room)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`clear-history ${resp.status} ${t}`);
  }
  return await resp.json();
}
