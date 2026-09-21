import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { NetconfAPI } from '../shared/types';

function subscribe<T>(name: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(`netconf:${name}`, listener);
  return () => ipcRenderer.removeListener(`netconf:${name}`, listener);
}
const api: NetconfAPI = {
  commitCandidate: () => ipcRenderer.invoke('netconf:commitCandidate'),
  discardCandidate: () => ipcRenderer.invoke('netconf:discardCandidate'),
  previewEdit: params => ipcRenderer.invoke('netconf:previewEdit', params),
  executeEdit: params => ipcRenderer.invoke('netconf:executeEdit', params),
  getProfiles: () => ipcRenderer.invoke('netconf:getProfiles'),
  saveProfile: params => ipcRenderer.invoke('netconf:saveProfile', params),
  selectProfile: id => ipcRenderer.invoke('netconf:selectProfile', id),
  deleteProfile: id => ipcRenderer.invoke('netconf:deleteProfile', id),
  previewRequest: params => ipcRenderer.invoke('netconf:previewRequest', params),
  executeRequest: params => ipcRenderer.invoke('netconf:executeRequest', params),
  connect: params => ipcRenderer.invoke('netconf:connect', params),
  disconnect: () => ipcRenderer.invoke('netconf:disconnect'),
  getConnectionState: () => ipcRenderer.invoke('netconf:getConnectionState'),
  fetchSchemas: () => ipcRenderer.invoke('netconf:fetchSchemas'),
  getModules: () => ipcRenderer.invoke('netconf:getModules'),
  getSchemaTree: () => ipcRenderer.invoke('netconf:getSchemaTree'),
  getBackendStatus: () => ipcRenderer.invoke('netconf:getBackendStatus'),
  onConnectionStateChanged: cb => subscribe('connection.stateChanged', cb),
  onSchemaProgress: cb => subscribe('schema.progress', cb),
  onLog: cb => subscribe('log.entry', cb),
  onBackendStatus: cb => subscribe('backend.status', cb),
};
contextBridge.exposeInMainWorld('netconf', api);
