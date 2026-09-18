import { app, BrowserWindow, dialog, session } from 'electron';
import path from 'node:path';
import { BackendProcess } from './backend-process';
import { registerIPC } from './ipc';

const backend = new BackendProcess();
let shutdownStarted = false;
let shutdownComplete = false;

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = new BrowserWindow({
    width: 1280, height: 850, minWidth: 800, minHeight: 600, backgroundColor: '#181c22',
    title: 'netconf-client',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  registerIPC(window, backend);
  backend.start(app.getAppPath());
  const rendererPath = path.join(__dirname, '../frontend/index.html');
  const loadRenderer = async () => {
    try {
      await window.loadFile(rendererPath);
    } catch (error) {
      console.error('Renderer failed to load:', error);
      if (!window.isDestroyed()) dialog.showErrorBox('Interface failed to load',
        `Could not load the application interface.\n${String(error)}`);
    }
  };
  if (process.env.NETCONF_DEV === '1') {
    // The dev orchestrator sends this only after Vite has written all output.
    // Watching output files directly races directory cleanup and asset writes.
    const onBuild = (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message &&
          message.type === 'renderer-built' && !window.isDestroyed()) void loadRenderer();
    };
    process.on('message', onBuild);
    window.once('closed', () => process.off('message', onBuild));
  }
  await loadRenderer();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void backend.stop().finally(() => { shutdownComplete = true; app.quit(); });
});

process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
