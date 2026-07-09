import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tachi', {
  startOAuth:    ()                  => ipcRenderer.invoke('oauth-start'),
  getMe:         ()                  => ipcRenderer.invoke('get-me'),
  getScores:     (userID: number)    => ipcRenderer.invoke('get-scores',     userID),
  getRecommend:  (userID: number)    => ipcRenderer.invoke('get-recommend',  userID),
  getStats:      (userID: number)    => ipcRenderer.invoke('get-stats',      userID),
  getTableData:  ()                  => ipcRenderer.invoke('get-table-data'),
  // バックグラウンド更新でスコアに差分があったときに main プロセスから呼ばれる
  onPBsUpdated:  (cb: () => void)    => ipcRenderer.on('pbs-updated', () => cb()),
});
