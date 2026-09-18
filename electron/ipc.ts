import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron';
import { ProfileStore } from './profiles';
import type { ConnectionParams, ProfileSave } from '../shared/types';
import type { BackendProcess } from './backend-process';

export function registerIPC(window: BrowserWindow, backend: BackendProcess) {
  let profiles: ProfileStore | undefined;
  const store = () => profiles ||= new ProfileStore(app.getPath('userData'), safeStorage);
  let connectionState = 'disconnected';
  const commands: Record<string, string> = {
    previewRequest: 'request.preview', executeRequest: 'request.execute', connect: 'connect', disconnect: 'disconnect', getConnectionState: 'connection.getState',
    fetchSchemas: 'schema.fetch', getModules: 'schema.getModules', getSchemaTree: 'schema.getTree',
  };
  const handles = [...Object.keys(commands), 'getBackendStatus', 'getProfiles', 'saveProfile', 'selectProfile', 'deleteProfile'];
  for (const method of handles) {
    ipcMain.handle(`netconf:${method}`, (event, params: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('Untrusted IPC sender');
      }
      if (method === 'getBackendStatus') return backend.status;
      try {
        if (method === 'getProfiles') return { result: store().state() };
        if (['saveProfile', 'selectProfile', 'deleteProfile'].includes(method)) {
          if (connectionState !== 'disconnected') return { error: { code: 'profile_busy', message: 'Disconnect before changing profiles' } };
          const result = method === 'saveProfile' ? store().save(params as ProfileSave) : method === 'selectProfile' ? store().select(params as string | null) : store().delete(params as string);
          return { result };
        }
        if (method === 'connect' && (params as ConnectionParams)?.profileId) params = store().resolve(params as ConnectionParams);
      } catch {
        return { error: { code: 'profile_error', message: 'Profile operation failed. Check profile fields and secure storage availability; enter a transient password if needed.' } };
      }
      return backend.request(commands[method], ['connect', 'previewRequest', 'executeRequest'].includes(method) ? params : {});
    });
  }
  const events = ['connection.stateChanged', 'schema.progress', 'log.entry', 'backend.status'];
  const listeners = events.map(name => {
    const handler = (data: unknown) => {
      if (name === 'connection.stateChanged') connectionState = (data as { state: string }).state;
      if (!window.isDestroyed()) window.webContents.send(`netconf:${name}`, data);
    };
    backend.on(name, handler);
    return { name, handler };
  });
  window.once('closed', () => {
    for (const method of handles) ipcMain.removeHandler(`netconf:${method}`);
    for (const { name, handler } of listeners) backend.off(name, handler);
  });
}
