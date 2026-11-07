import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ApiClient } from './api';
import { AuthService } from './auth';
import { EventStream, describeEvent } from './events';
import { SettingsStore, policyFilePath } from './settings';
import type { AppSettings, PickedFile } from './shared';

const APP_ID = 'ch.balancescout.desktop';
const isDev = !!process.env.VITE_DEV_SERVER_URL;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let activity: string | null = null;
let recent: { id: string; name: string }[] = [];
let me = '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.setAppUserModelId(APP_ID); // nötig für Windows-Benachrichtigungen

const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'), policyFilePath());
const auth = new AuthService({
  openBrowser: async url => shell.openExternal(url),
  windowHandle: () => win?.getNativeWindowHandle(),
  cacheDir: app.getPath('userData'),
});
const s = (): AppSettings => settings.get();
const api = new ApiClient({ baseUrl: () => s().serverUrl, token: () => auth.accessToken(s()) });
const stream = new EventStream({
  url: id => api.url(`/api/engagements/${id}/events`),
  token: () => auth.accessToken(s()),
  onEvent: e => {
    win?.webContents.send('bsb:event', e);
    notify(e);
  },
  onState: st => {
    win?.webContents.send('bsb:connection', st);
    updateTray();
  },
});

function iconPath(name: string): string {
  return path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'build'), name);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    show: false,
    title: 'Balance Scout',
    icon: iconPath('icon.png'),
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  win.setMenuBarVisibility(false);
  if (isDev) void win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win?.show();
  });
  // Schliessen = in die Taskleiste minimieren
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        new Notification({ title: 'Balance Scout läuft weiter', body: 'Die App bleibt im Infobereich der Taskleiste aktiv und meldet Neuigkeiten.' }).show();
      }
    }
  });
  // Keine Navigation weg von der App; externe Links nur https im Browser
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
}
let trayHintShown = false;

function showWindow(engagementId?: string): void {
  if (!win) createWindow();
  win!.show();
  if (win!.isMinimized()) win!.restore();
  win!.focus();
  if (engagementId) win!.webContents.send('bsb:navigate', engagementId);
}

function updateTray(): void {
  if (!tray) return;
  tray.setToolTip(activity ? `Balance Scout – ${activity}` : 'Balance Scout');
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Balance Scout öffnen', click: () => showWindow(), type: 'normal' },
    { type: 'separator' },
  ];
  if (activity) items.push({ label: `⏳ ${activity}`, enabled: false }, { type: 'separator' });
  if (recent.length) {
    items.push({ label: 'Zuletzt geöffnet', enabled: false });
    for (const r of recent.slice(0, 5)) items.push({ label: `   ${r.name}`, click: () => showWindow(r.id) });
    items.push({ type: 'separator' });
  }
  items.push(
    { label: me ? `Angemeldet: ${me}` : 'Nicht angemeldet', enabled: false },
    {
      label: 'Mit Windows starten',
      type: 'checkbox',
      checked: s().autoStart,
      enabled: !settings.managed().autoStart,
      click: mi => {
        settings.set({ autoStart: mi.checked });
        applyAutoStart();
      },
    },
    { type: 'separator' },
    {
      label: 'Beenden',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray(): void {
  const img = nativeImage.createFromPath(iconPath('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()));
  updateTray();
}

function applyAutoStart(): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: s().autoStart, args: ['--hidden'] });
}

function notify(e: { actor: string; engagementId: string } & Parameters<typeof describeEvent>[0]): void {
  const pref = s().notifications;
  if (pref === 'keine' || !Notification.isSupported()) return;
  if (pref === 'andere' && e.actor === me) return;
  if (win?.isVisible() && win.isFocused() && e.actor !== me) {
    // Fenster ist aktiv: die Oberfläche zeigt die Änderung live an
    return;
  }
  const d = describeEvent(e, me);
  if (!d) return;
  const n = new Notification({ title: d.title, body: d.body, icon: iconPath('icon.png') });
  n.on('click', () => showWindow(e.engagementId));
  n.show();
}

// ---------------- IPC (einzige Schnittstelle zur Oberfläche) ----------------
function registerIpc(): void {
  ipcMain.handle('settings:get', () => ({ settings: s(), managed: settings.managed(), complete: settings.complete() }));
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    const err = settings.set(patch);
    if (!err) applyAutoStart();
    updateTray();
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('auth:status', async () => {
    if (!settings.complete()) return { signedIn: false, broker: false };
    const st = await auth.status(s());
    me = st.account?.username ?? '';
    updateTray();
    return st;
  });
  ipcMain.handle('auth:signIn', async () => {
    const st = await auth.signIn(s());
    me = st.account?.username ?? '';
    updateTray();
    return st;
  });
  ipcMain.handle('auth:signOut', async () => {
    stream.stop();
    me = '';
    updateTray();
    return auth.signOut(s());
  });

  ipcMain.handle('api:request', (_e, method: string, p: string, body?: unknown) => api.request(method, p, body));
  ipcMain.handle('api:pickFiles', async (_e, opts: { multiple: boolean; filters: Electron.FileFilter[] }) => {
    const r = await dialog.showOpenDialog(win!, { properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: opts.filters });
    if (r.canceled) return [];
    const out: PickedFile[] = [];
    for (const f of r.filePaths) out.push({ path: f, name: path.basename(f), size: (await stat(f)).size });
    return out;
  });
  ipcMain.handle('api:upload', async (_e, p: string, files: PickedFile[], fields?: Record<string, string>, fieldName?: string) => {
    // Nur Dateien, die der Benutzer im Dialog gewählt hat (Pfad + Grösse müssen übereinstimmen)
    for (const f of files) {
      const st = await stat(f.path).catch(() => null);
      if (!st || st.size !== f.size) return { ok: false, status: 0, error: `Datei ${f.name} nicht mehr verfügbar.` };
    }
    return api.upload(p, files, fields, fieldName);
  });

  ipcMain.handle('events:watch', (_e, id: string | null) => stream.watch(id));
  ipcMain.handle('app:setActivity', (_e, label: string | null) => {
    activity = label;
    updateTray();
  });
  ipcMain.handle('app:setRecent', (_e, items: { id: string; name: string }[]) => {
    recent = items.slice(0, 5);
    updateTray();
  });
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('app:version', () => app.getVersion());
}

function contentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev
            ? "default-src 'self' 'unsafe-inline' http://localhost:5173 ws://localhost:5173"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'",
        ],
      },
    });
  });
  // Oberfläche darf keine Berechtigungen (Kamera, Mikrofon …) anfordern
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

app.on('second-instance', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
  stream.stop();
});
app.on('window-all-closed', () => {
  /* App bleibt in der Taskleiste aktiv */
});

void app.whenReady().then(() => {
  contentSecurityPolicy();
  registerIpc();
  createWindow();
  createTray();
  applyAutoStart();
});
