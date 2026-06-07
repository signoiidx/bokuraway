const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tachi', {
  startOAuth:   ()         => ipcRenderer.invoke('oauth-start'),
  getMe:        ()         => ipcRenderer.invoke('get-me'),
  getScores:    (userID)   => ipcRenderer.invoke('get-scores',    userID),
  getRecommend: (userID)   => ipcRenderer.invoke('get-recommend', userID),
  getStats:     (userID)   => ipcRenderer.invoke('get-stats',     userID),
});
