const { Query } = require('../../utils/query');
const { formatBytes } = require('../../utils/format');
const { RespData, RespError } = require('../../utils/resp');
const { CommonStatus } = require('../../utils/status');
const { chatApiRequest } = require('../../utils/ai-request');

/**
 * POST /chat
 * body: { room, user_id, content, persona? }
 * - 将用户消息存入 message 表
 * - 调用后端大模型 API（使用服务器环境变量中的密钥）生成回复
 * - 将 AI 回复写入 message 表
 * - 返回 { reply }
 */
const chat = async (req, res) => {
  try {
    const { room, user_id, content, persona } = req.body;
    if (!room || !user_id || content === undefined) return RespError(res, CommonStatus.INVALID_PARAM);

    // 写入用户消息（sender_id = user_id, receiver_id = -100 表示 AI 内置）
    const userMsg = {
      sender_id: user_id,
      receiver_id: -100,
      content: content,
      room: room,
      type: 'private',
      media_type: 'text',
      file_size: 0,
      status: 1
    };
    const insertRes = await Query('INSERT INTO message SET ?', [userMsg]);

    // 调用外部 AI（通过 utils/ai-request 封装）
    const apiResp = await chatApiRequest({ messages: persona ? [{ role: 'system', content: persona }, { role: 'user', content }] : undefined, content, room });
    const replyText = apiResp?.reply || '抱歉，AI 未返回结果';

    // 写入 AI 回复（sender_id = 0）
    const aiMsg = {
      sender_id: 0,
      receiver_id: user_id,
      content: replyText,
      room: room,
      type: 'private',
      media_type: 'text',
      file_size: 0,
      status: 1
    };
    await Query('INSERT INTO message SET ?', [aiMsg]);

    return RespData(res, { reply: replyText });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    return RespError(res, CommonStatus.SERVER_ERR);
  }
};

/**
 * DELETE /history?room=...
 * 清空指定房间的消息记录（主要用于 ai 房间），要求提供 room
 */
const clearHistory = async (req, res) => {
  try {
    const room = req.query.room;
    if (!room) return RespError(res, CommonStatus.INVALID_PARAM);
    // 删除该 room 下的所有消息
    await Query('DELETE FROM message WHERE room = ?', [room]);
    return RespData(res, { ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    return RespError(res, CommonStatus.SERVER_ERR);
  }
};

module.exports = {
  chat,
  clearHistory
};
