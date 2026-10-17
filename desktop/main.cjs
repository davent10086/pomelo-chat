const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const { PANEL_SIZE, TAB_SIZE, GAP, dockBounds } = require('./geometry.cjs');
const { validAuth, validChat, trustedFrame } = require('./protocol.cjs');

const devUrl = new URL(process.env.POMELO_DESKTOP_URL || 'http://127.0.0.1:5173');
if (devUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(devUrl.hostname)) {
  throw new Error('Desktop development URL must be a loopback HTTP address');
}
const origin = devUrl.origin;
let mainWindow, assistantWindow;
let snapshot = { revision: 0, auth: null, chat: null };
let expanded = false, resizeTicket = 0, syncing = false, restoreBounds = null;
const originCorner = 'left top';
let assistantReady = false;

function broadcast() {
  snapshot = { ...snapshot, revision: snapshot.revision + 1 };
  for (const window of [mainWindow, assistantWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('desktop:changed', snapshot);
  }
  if (assistantReady && !assistantWindow.isDestroyed()) {
    if (snapshot.auth && !mainWindow.isMinimized()) assistantWindow.showInactive();
    else assistantWindow.hide();
  }
}

function requireRole(event, role) {
  if (!trustedFrame(event, role === 'main' ? mainWindow : assistantWindow, origin, role)) {
    throw new Error('Untrusted desktop IPC sender');
  }
}
function requireEither(event) {
  if (!trustedFrame(event, mainWindow, origin, 'main') &&
    !trustedFrame(event, assistantWindow, origin, 'assistant')) throw new Error('Untrusted desktop IPC sender');
}
function workArea() { return screen.getDisplayMatching(mainWindow.getBounds()).workArea; }
function syncDock() {
  if (syncing || !mainWindow || !assistantWindow || mainWindow.isDestroyed() || assistantWindow.isDestroyed()) return;
  syncing = true;
  try {
    const area = workArea();
    const bounds = restoreBounds ? { ...area, width: area.width - GAP - (expanded ? PANEL_SIZE.width : TAB_SIZE.width) } : mainWindow.getBounds();
    const next = dockBounds(bounds, area, expanded);
    mainWindow.setMinimumSize(Math.min(640, next.main.width), Math.min(480, next.main.height));
    for (const [window, bounds] of [[mainWindow, next.main], [assistantWindow, next.assistant]]) {
      const previous = window.getBounds();
      if (['x', 'y', 'width', 'height'].some(key => previous[key] !== bounds[key])) window.setBounds(bounds);
    }
  } finally { syncing = false; }
}
ipcMain.handle('desktop:window', (event, action) => {
  requireRole(event, 'main');
  if (!['minimize', 'maximize', 'close'].includes(action)) throw new Error('Invalid window action');
  if (action === 'close') { app.quit(); return false; }
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') {
    if (restoreBounds) { const previous = restoreBounds; restoreBounds = null; mainWindow.setBounds(previous); }
    else { restoreBounds = mainWindow.getBounds(); const area = workArea();
      mainWindow.setBounds({ ...area, width: area.width - GAP - (expanded ? PANEL_SIZE.width : TAB_SIZE.width) }); }
    syncDock();
  }
  return !!restoreBounds;
});

ipcMain.handle('desktop:snapshot', event => { requireEither(event); return snapshot; });
ipcMain.handle('desktop:auth', (event, auth) => {
  requireRole(event, 'main');
  if (!validAuth(auth)) throw new Error('Invalid auth snapshot');
  const changed = snapshot.auth?.token !== auth?.token || snapshot.auth?.user.id !== auth?.user.id;
  snapshot = { ...snapshot, auth, chat: changed ? null : snapshot.chat };
  if (changed) resetAssistant();
  broadcast();
});
ipcMain.handle('desktop:invalidate', (event, token) => {
  requireEither(event);
  if (typeof token === 'string' && snapshot.auth?.token === token) {
    snapshot = { ...snapshot, auth: null, chat: null };
    resetAssistant();
    broadcast();
  }
});
ipcMain.handle('desktop:chat', (event, chat) => {
  requireRole(event, 'main');
  if (!validChat(chat)) throw new Error('Invalid chat snapshot');
  snapshot = { ...snapshot, chat: snapshot.auth ? chat : null };
  broadcast();
});
ipcMain.handle('desktop:resize', (event, value) => {
  requireRole(event, 'assistant');
  if (!value || typeof value.expanded !== 'boolean' || !Number.isSafeInteger(value.ticket) || value.ticket < 1) {
    throw new Error('Invalid resize request');
  }
  if (value.ticket < resizeTicket || !snapshot.auth || value.token !== snapshot.auth.token) return { origin: originCorner, ...assistantWindow.getBounds() };
  resizeTicket = value.ticket;
  if (value.expanded !== expanded) {
    expanded = value.expanded;
    syncDock();
  }
  return { origin: originCorner, ...assistantWindow.getBounds() };
});
ipcMain.on('desktop:drag', (event, value) => {
  try {
    requireRole(event, 'assistant');
    if (!snapshot.auth || !value || !Number.isFinite(value.dx) || !Number.isFinite(value.dy) ||
      Math.abs(value.dx) > 4096 || Math.abs(value.dy) > 4096) return;
    const bounds = mainWindow.getBounds();
    restoreBounds = null;
    const next = { ...bounds, x: bounds.x + value.dx, y: bounds.y + value.dy };
    mainWindow.setBounds(next);
    syncDock();
  } catch { /* Ignore messages from destroyed/navigated frames. */ }
});

function resetAssistant() {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  expanded = false;
  resizeTicket = 0;
  syncDock();
}

function secureWindow(window, assistant) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowed = url => {
    try {
      const target = new URL(url);
      return target.origin === origin && (assistant ? target.pathname === '/desktop-assistant' : target.pathname !== '/desktop-assistant');
    } catch { return false; }
  };
  window.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) event.preventDefault(); });
}

app.whenReady().then(async () => {
  const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true };
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1100, area.width - PANEL_SIZE.width - GAP);
  mainWindow = new BrowserWindow({ x: area.x + Math.max(0, Math.round((area.width - width - PANEL_SIZE.width - GAP) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - 800) / 2)), width, height: Math.min(800, area.height),
    minWidth: Math.min(640, width), minHeight: Math.min(480, area.height), frame: false, transparent: true, backgroundColor: '#00000000', roundedCorners: true, maximizable: false, title: 'Pomelo Chat', icon: path.join(__dirname, '../client/public/yuzu-chat.png'), show: false, webPreferences });
  assistantWindow = new BrowserWindow({
    ...dockBounds(mainWindow.getBounds(), area, false).assistant, parent: mainWindow,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, show: false, webPreferences
  });
  secureWindow(mainWindow, false);
  secureWindow(assistantWindow, true);
  mainWindow.on('move', syncDock);
  mainWindow.on('resize', syncDock);
  mainWindow.on('will-move', () => { restoreBounds = null; });
  mainWindow.on('will-resize', () => { restoreBounds = null; });
  mainWindow.on('minimize', () => assistantWindow.hide());
  mainWindow.on('restore', () => { syncDock(); broadcast(); });
  mainWindow.on('show', () => { syncDock(); broadcast(); });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('closed', () => app.quit());
  assistantWindow.on('closed', () => app.quit());
  mainWindow.webContents.on('render-process-gone', () => {
    snapshot = { ...snapshot, auth: null, chat: null }; resetAssistant(); broadcast();
  });
  assistantWindow.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) { assistantReady = false; resetAssistant(); assistantWindow.hide(); }
  });
  assistantWindow.webContents.on('did-finish-load', () => { assistantReady = true; broadcast(); });
  screen.on('display-removed', syncDock);
  screen.on('display-metrics-changed', syncDock);
  await Promise.all([mainWindow.loadURL(origin), assistantWindow.loadURL(`${origin}/desktop-assistant`)]);
  mainWindow.show();
}).catch(error => { console.error(error.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
