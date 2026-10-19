const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function normalizeServer(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入有效的服务器地址');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('服务器地址需以 https:// 开头'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请填写 HTTPS 服务器根地址；本机调试可使用 http://127.0.0.1:端口');
  }
  return url.origin;
}
const serverKey = value => createHash('sha256').update(value).digest('hex');
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function createSettings(directory, safeStorage, validAuth) {
  const configFile = path.join(directory, 'desktop-config.json');
  let serverURL = '';
  try { serverURL = normalizeServer(readJSON(configFile)?.serverURL); } catch { /* First launch. */ }
  const credentialsFile = () => path.join(directory, `session-${serverKey(serverURL)}.json`);
  return {
    get serverURL() { return serverURL; },
    setServer(value) {
      const normalized = normalizeServer(value);
      writeJSON(configFile, { version: 1, serverURL: normalized });
      serverURL = normalized;
      return normalized;
    },
    restore() {
      if (!serverURL || !safeStorage.isEncryptionAvailable()) return null;
      try {
        const saved = readJSON(credentialsFile());
        if (saved?.version !== 1 || saved.serverURL !== serverURL) return null;
        const auth = JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')));
        return auth && validAuth(auth) ? auth : null;
      } catch { return null; }
    },
    remember(auth) {
      if (!serverURL || !auth || !validAuth(auth)) throw new Error('无效的登录信息');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，请取消“记住登录”后重试');
      writeJSON(credentialsFile(), {
        version: 1, serverURL,
        encrypted: safeStorage.encryptString(JSON.stringify(auth)).toString('base64')
      });
    },
    forget() { if (serverURL) fs.rmSync(credentialsFile(), { force: true }); }
  };
}
module.exports = { normalizeServer, serverKey, createSettings };
