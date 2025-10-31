const https = require('https');

// 简单封装：使用服务器端环境变量调用 DeepSeek/OpenAI 风格的 chat completions API
// 环境变量：ASSISTANT_API_KEY, ASSISTANT_BASE_URL, ASSISTANT_MODEL

const postJson = (url, body, headers = {}) => {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const opts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
      };
      const req = https.request(opts, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', e => reject(e));
      req.write(JSON.stringify(body));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
};

const chatApiRequest = async ({ messages, content, room }) => {
  const apiKey = process.env.ASSISTANT_API_KEY || process.env.VITE_DEEPSEEK_API_KEY || process.env.VITE_ASSISTANT_API_KEY;
  const baseUrl = (process.env.ASSISTANT_BASE_URL || process.env.VITE_ASSISTANT_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.ASSISTANT_MODEL || process.env.VITE_ASSISTANT_MODEL || 'deepseek-chat';

  if (!apiKey) {
    // 没有服务器端 key，返回 null 让调用方回退
    return null;
  }

  // 支持两种调用模式：传入 messages（OpenAI-style）或仅传入 content（将作为 user 消息）
  const body = messages && messages.length ? { model, messages, stream: false } : { model, messages: [{ role: 'user', content }], stream: false };

  const url = `${baseUrl}/v1/chat/completions`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const resp = await postJson(url, body, headers).catch(err => {
    // eslint-disable-next-line no-console
    console.error('chatApiRequest error', err);
    return null;
  });
  if (!resp) return null;
  const text = resp?.choices?.[0]?.message?.content || resp?.choices?.[0]?.text || null;
  return { reply: String(text || '') };
};

module.exports = { chatApiRequest };
