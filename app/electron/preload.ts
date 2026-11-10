import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { BsbBridge, Progress } from './shared';

const bridge: BsbBridge & { app: BsbBridge['app'] & { loadResult(id: string): Promise<unknown> } } = {
  pick: {
    trialBalance: d => ipcRenderer.invoke('pick:trialBalance', d),
    evidence: (kind, d) => ipcRenderer.invoke('pick:evidence', kind, d),
    cloudLocations: () => ipcRenderer.invoke('pick:cloudLocations'),
    targetDir: d => ipcRenderer.invoke('pick:targetDir', d),
    // Drag & Drop: Pfad der Datei/des Ordners über Electron ermitteln und im Hauptprozess prüfen
    pathOf: file => ipcRenderer.invoke('pick:validate', webUtils.getPathForFile(file)),
  },
  engine: {
    previewTrialBalance: (p, s, o) => ipcRenderer.invoke('engine:preview', p, s, o),
    run: input => ipcRenderer.invoke('engine:run', input),
    cancel: () => ipcRenderer.invoke('engine:cancel'),
    filePreview: (p: string, page: number) => ipcRenderer.invoke('engine:filePreview', p, page),
    onProgress: cb => {
      const h = (_e: IpcRendererEvent, p: Progress) => cb(p);
      ipcRenderer.on('bsb:progress', h);
      return () => ipcRenderer.removeListener('bsb:progress', h);
    },
  },
  review: {
    save: (id, d) => ipcRenderer.invoke('review:save', id, d),
    finalize: (id, d) => ipcRenderer.invoke('review:finalize', id, d),
    groups: () => ipcRenderer.invoke('review:groups'),
    importRates: () => ipcRenderer.invoke('rates:import'),
    fixedAssets: (id, p) => ipcRenderer.invoke('review:fixedAssets', id, p),
    exportFixedAssets: (id, p, name) => ipcRenderer.invoke('review:exportFixedAssets', id, p, name),
    receivables: (id, p) => ipcRenderer.invoke('review:receivables', id, p),
    exportReceivables: (id, p, name, format) => ipcRenderer.invoke('review:exportReceivables', id, p, name, format),
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
