const { sameOrigin } = require('./app-protocol.cjs');
function validAuth(value) {
  return value === null || Boolean(value && typeof value.token === 'string' &&
    value.token.length > 0 && value.token.length <= 8192 && value.user &&
    Number.isSafeInteger(value.user.id) && value.user.id > 0 &&
    ['username', 'name', 'avatar', 'phone', 'signature', 'created_at'].every(
      key => typeof value.user[key] === 'string' && value.user[key].length <= 4096));
}

function validChat(value) {
  return value === null || Boolean(value && typeof value.room === 'string' &&
    value.room.length > 0 && value.room.length <= 128 && !value.room.startsWith('ai_') &&
    (value.type === 'private' || value.type === 'group') &&
    Number.isSafeInteger(value.receiverId) && value.receiverId > 0 &&
    typeof value.name === 'string' && value.name.length <= 256);
}

function trustedFrame(event, window, origin, role) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return sameOrigin(url.href, origin) && (role === 'assistant'
      ? url.pathname === '/desktop-assistant' : url.pathname !== '/desktop-assistant');
  } catch { return false; }
}

module.exports = { validAuth, validChat, trustedFrame };
