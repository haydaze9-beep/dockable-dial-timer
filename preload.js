const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dialApi', {
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  onDockState: (callback) =>
    ipcRenderer.on('dock-state', (_event, state) => callback(state)),

  // New in Step 8
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveMinutes: (m) => ipcRenderer.send('save-minutes', m),
  alarmFired: () => ipcRenderer.send('alarm-fired'),
  showMenu: () => ipcRenderer.send('show-menu'),
  onSoundState: (callback) =>
    ipcRenderer.on('sound-state', (_event, on) => callback(on))
});