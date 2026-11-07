import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BsbBridge, ServerEvent } from './shared';

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const bridge: BsbBridge = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: s => ipcRenderer.invoke('settings:set', s),
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    signIn: () => ipcRenderer.invoke('auth:signIn'),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
  },
  api: {
    request: (method, path, body) => ipcRenderer.invoke('api:request', method, path, body),
    pickFiles: opts => ipcRenderer.invoke('api:pickFiles', opts),
    upload: (path, files, fields, fieldName) => ipcRenderer.invoke('api:upload', path, files, fields, fieldName),
  },
  events: {
    watch: id => ipcRenderer.invoke('events:watch', id),
    on: cb => listen<ServerEvent>('bsb:event', cb),
    onConnection: cb => listen('bsb:connection', cb),
  },
  app: {
    setActivity: label => ipcRenderer.invoke('app:setActivity', label),
    setRecent: items => ipcRenderer.invoke('app:setRecent', items),
    onNavigate: cb => listen<string>('bsb:navigate', cb),
    openExternal: url => ipcRenderer.invoke('app:openExternal', url),
    version: () => ipcRenderer.invoke('app:version'),
  },
};

contextBridge.exposeInMainWorld('bsb', bridge);
