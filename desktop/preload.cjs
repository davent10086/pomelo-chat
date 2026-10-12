const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pomeloDesktop', {
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
