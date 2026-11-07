import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { BsbBridge, Progress } from './shared';

const bridge: BsbBridge & { app: BsbBridge['app'] & { loadResult(id: string): Promise<unknown> } } = {
  pick: {
    trialBalance: () => ipcRenderer.invoke('pick:trialBalance'),
    evidence: kind => ipcRenderer.invoke('pick:evidence', kind),
    targetDir: d => ipcRenderer.invoke('pick:targetDir', d),
    // Drag & Drop: Pfad der Datei/des Ordners über Electron ermitteln und im Hauptprozess prüfen
    pathOf: file => ipcRenderer.invoke('pick:validate', webUtils.getPathForFile(file)),
  },
  engine: {
    previewTrialBalance: (p, s, m) => ipcRenderer.invoke('engine:preview', p, s, m),
    run: input => ipcRenderer.invoke('engine:run', input),
    cancel: () => ipcRenderer.invoke('engine:cancel'),
    onProgress: cb => {
      const h = (_e: IpcRendererEvent, p: Progress) => cb(p);
      ipcRenderer.on('bsb:progress', h);
      return () => ipcRenderer.removeListener('bsb:progress', h);
    },
  },
  app: {
    openPath: p => ipcRenderer.invoke('app:openPath', p),
    showInFolder: p => ipcRenderer.invoke('app:showInFolder', p),
    copyText: t => ipcRenderer.invoke('app:copyText', t),
    history: () => ipcRenderer.invoke('app:history'),
    removeHistory: id => ipcRenderer.invoke('app:removeHistory', id),
    settings: () => ipcRenderer.invoke('app:settings'),
    saveSettings: s => ipcRenderer.invoke('app:saveSettings', s),
    version: () => ipcRenderer.invoke('app:version'),
    loadResult: id => ipcRenderer.invoke('app:loadResult', id),
  },
};

contextBridge.exposeInMainWorld('bsb', bridge);
