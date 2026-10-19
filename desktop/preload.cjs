const { contextBridge, ipcRenderer } = require('electron');
let runtime;

contextBridge.exposeInMainWorld('pomeloDesktop', {
  getRuntime: () => (runtime ||= ipcRenderer.sendSync('desktop:runtime')),
  setServer: value => ipcRenderer.invoke('desktop:server', value),
  rememberAuth: auth => ipcRenderer.invoke('desktop:remember', auth),
  downloadFile: (storagePath, fileName) => ipcRenderer.invoke('desktop:download', storagePath, fileName),
  windowControl: action => ipcRenderer.invoke('desktop:window', action),
  getSnapshot: () => ipcRenderer.invoke('desktop:snapshot'),
  publishAuth: auth => ipcRenderer.invoke('desktop:auth', auth),
  invalidateAuth: token => ipcRenderer.invoke('desktop:invalidate', token),
  publishChat: chat => ipcRenderer.invoke('desktop:chat', chat),
  resizeAssistant: (expanded, ticket, token) => ipcRenderer.invoke('desktop:resize', { expanded, ticket, token }),
  dragAssistant: (dx, dy) => ipcRenderer.send('desktop:drag', { dx, dy }),
  subscribe: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('desktop:changed', listener);
    return () => ipcRenderer.removeListener('desktop:changed', listener);
  }
});
