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

  if (!apiKey) {
    throw new Error('no-api-key');
  }

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

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`chat-api ${resp.status} ${t}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return String(text);
}
