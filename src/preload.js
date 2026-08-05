const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mimi', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.send('state:save', state),
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  listClaudeSessions: () => ipcRenderer.invoke('claude:list-sessions'),
  ptyInput: (tabId, data) => ipcRenderer.send('pty:input', { tabId, data }),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  ptyKill: (tabId) => ipcRenderer.send('pty:kill', { tabId }),
  killTmuxSession: (name) => ipcRenderer.send('tmux:kill-session', name),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, tabId, data) => cb(tabId, data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, tabId) => cb(tabId)),
  onClaudeSessions: (cb) => ipcRenderer.on('claude:sessions', (_e, sessions) => cb(sessions)),
});
