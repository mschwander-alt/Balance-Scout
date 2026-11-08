import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, session, shell, utilityProcess, type UtilityProcess } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, HistoryEntry, JobInput, PickedPath, Progress, SignConvention, TbPreview } from './shared';

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let activity: string | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('ch.balancescout.lokal');

// ------------------------------------------------------------------ Pfade
const res = (...p: string[]) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', ...p));
const enginePath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'node_modules', '@balance-scout', 'engine', 'dist', 'runner.js')
    : path.join(__dirname, '..', 'node_modules', '@balance-scout', 'engine', 'dist', 'runner.js');
const tessdata = () => (app.isPackaged ? path.join(process.resourcesPath, 'tessdata') : path.join(__dirname, '..', 'node_modules', '@balance-scout', 'engine', 'tessdata'));
if (!app.isPackaged && process.env.BSB_USER_DATA) app.setPath('userData', process.env.BSB_USER_DATA);
const userFile = (n: string) => path.join(app.getPath('userData'), n);

// ------------------------------------------------------------------ Einstellungen & Verlauf
const DEFAULTS: AppSettings = { defaultTargetBase: '', fileMode: 'copy', toleranceChf: '1.00', signConvention: 'signed', notifications: true, autoStart: false };
function readJson<T>(n: string, d: T): T {
  try {
    return existsSync(userFile(n)) ? { ...d, ...JSON.parse(readFileSync(userFile(n), 'utf8')) } : d;
  } catch {
    return d;
  }
}
function writeJson(n: string, v: unknown): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(userFile(n), JSON.stringify(v, null, 2), 'utf8');
}
const settings = (): AppSettings => readJson('settings.json', DEFAULTS);
const history = (): HistoryEntry[] => {
  try {
    return existsSync(userFile('history.json')) ? JSON.parse(readFileSync(userFile('history.json'), 'utf8')) : [];
  } catch {
    return [];
  }
};

// ------------------------------------------------------------------ Engine im Hintergrundprozess
let engine: UtilityProcess | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let currentRunId: string | null = null;

function getEngine(): UtilityProcess {
  if (engine) return engine;
  // Eigene Ausgabekanäle (nicht 'inherit'): sonst hält der Hintergrundprozess unter Windows
  // die Kanäle der App offen, und das Beenden wirkt unvollständig.
  const p = utilityProcess.fork(enginePath(), [], { serviceName: 'Balance Scout Prüf-Engine', stdio: 'pipe' });
  p.stdout?.on('data', (d: Buffer) => process.stdout.write(`[engine] ${d}`));
  p.stderr?.on('data', (d: Buffer) => process.stderr.write(`[engine] ${d}`));
  p.on('message', (m: { id?: string; kind: string; progress?: Progress; result?: unknown; error?: string }) => {
    if (m.kind === 'progress' && m.progress) {
      win?.webContents.send('bsb:progress', m.progress);
      const pr = m.progress;
      setActivity(pr.total ? `Prüfung läuft – ${pr.current}/${pr.total}` : 'Prüfung läuft');
      win?.setProgressBar(pr.total ? (pr.current ?? 0) / pr.total : 2); // 2 = unbestimmt
      return;
    }
    if (!m.id) return;
    const h = pending.get(m.id);
    if (!h) return;
    pending.delete(m.id);
    if (m.kind === 'result') h.resolve(m.result);
    else h.reject(new Error(m.error ?? 'Unbekannter Fehler'));
  });
  p.on('exit', code => {
    engine = null;
    for (const [, h] of pending) h.reject(new Error(code === 0 ? 'Abgebrochen.' : `Prüf-Engine unerwartet beendet (Code ${code}).`));
    pending.clear();
    resetActivity();
  });
  engine = p;
  return p;
}

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: v => resolve(v as T), reject });
    getEngine().postMessage({ ...msg, id });
  });
}

function setActivity(a: string | null): void {
  activity = a;
  updateTray();
}
function resetActivity(): void {
  win?.setProgressBar(-1);
  setActivity(null);
}

// ------------------------------------------------------------------ Belegvorschau
/** Nur Dateien der geöffneten Prüfung dürfen in der Vorschau angezeigt werden */
const previewAllowed = new Set<string>();
const previewCache = new Map<string, unknown>();
function allowPreviewFor(result: unknown): void {
  previewAllowed.clear();
  previewCache.clear();
  const docs = (result as { documents?: { absPath?: string; placement?: { newPath?: string | null } | null }[] } | null)?.documents ?? [];
  for (const d of docs) {
    if (d.absPath) previewAllowed.add(path.resolve(d.absPath));
    if (d.placement?.newPath) previewAllowed.add(path.resolve(d.placement.newPath));
  }
}

// ------------------------------------------------------------------ Fenster & Taskleiste
function createWindow(): void {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1050, minHeight: 680, show: false, title: 'Balance Scout',
    icon: res('build', 'icon.png'), backgroundColor: '#f6f7f9',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.setMenuBarVisibility(false);
  if (isDev) void win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.once('ready-to-show', () => !process.argv.includes('--hidden') && win?.show());
  win.on('close', e => {
    if (quitting) return;
    if (currentRunId || settings().autoStart) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showWindow(): void {
  if (!win) createWindow();
  win!.show();
  win!.focus();
}

function updateTray(): void {
  if (!tray) return;
  tray.setToolTip(activity ? `Balance Scout – ${activity}` : 'Balance Scout');
  const recent = history().slice(0, 5);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Balance Scout öffnen', click: showWindow },
      ...(activity ? [{ type: 'separator' as const }, { label: `⏳ ${activity}`, enabled: false }] : []),
      ...(recent.length
        ? [{ type: 'separator' as const }, { label: 'Letzte Prüfungen', enabled: false }, ...recent.map(h => ({ label: `   ${h.mandate}`, click: () => void shell.openPath(h.excelPath) }))]
        : []),
      { type: 'separator' },
      {
        label: 'Mit Windows starten', type: 'checkbox', checked: settings().autoStart,
        click: mi => {
          writeJson('settings.json', { ...settings(), autoStart: mi.checked });
          if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: mi.checked, args: ['--hidden'] });
        },
      },
      { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

// ------------------------------------------------------------------ IPC
/** Nur für automatisierte Tests der Entwicklungsversion: vorgegebene Dialog-Antworten (in der installierten App wirkungslos) */
const e2ePicks: Record<string, unknown> | null = !app.isPackaged && process.env.BSB_E2E_PICKS ? JSON.parse(process.env.BSB_E2E_PICKS) : null;
const asPicked = (p: string): PickedPath => ({ path: p, name: path.basename(p), isDirectory: statSync(p).isDirectory() });

function registerIpc(): void {
  ipcMain.handle('pick:trialBalance', async () => {
    if (e2ePicks) return asPicked(e2ePicks.trialBalance as string);
    const r = await dialog.showOpenDialog(win!, { title: 'Saldobilanz wählen', properties: ['openFile'], filters: [{ name: 'Saldobilanz', extensions: ['xlsx', 'xlsm', 'xls', 'csv'] }] });
    return r.canceled || !r.filePaths[0] ? null : asPicked(r.filePaths[0]);
  });
  ipcMain.handle('pick:evidence', async (_e, kind: 'files' | 'folders') => {
    if (e2ePicks) return (e2ePicks[kind] as string[]).map(asPicked);
    const r = await dialog.showOpenDialog(win!, {
      title: kind === 'folders' ? 'Ordner mit Kundenunterlagen wählen' : 'Belege wählen',
      properties: kind === 'folders' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths.map(asPicked);
  });
  ipcMain.handle('pick:targetDir', async (_e, defaultPath?: string) => {
    if (e2ePicks) return e2ePicks.targetDir as string;
    const r = await dialog.showOpenDialog(win!, { title: 'Interner Zielordner', defaultPath: defaultPath || settings().defaultTargetBase || undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('pick:validate', (_e, p: string) => {
    try {
      return asPicked(p);
    } catch {
      return null;
    }
  });

  ipcMain.handle('engine:preview', (_e, p: string, sign: SignConvention, mapping?: TbPreview['detected']) =>
    call<TbPreview>({ type: 'previewTrialBalance', path: p, signConvention: sign, mapping: mapping ?? undefined }),
  );
  ipcMain.handle('engine:run', async (_e, input: JobInput) => {
    if (currentRunId) throw new Error('Es läuft bereits eine Prüfung.');
    currentRunId = randomUUID();
    const reportDir = input.targetDir ?? path.dirname(input.trialBalancePath);
    try {
      const result = await call<{ excelPath: string; summary: { counts: Record<string, number>; coverage: number }; documents: unknown[] }>({
        type: 'run', reportDir, input: { ...input, ocr: { langPath: tessdata() } },
      });
      const entry: HistoryEntry = {
        id: currentRunId, at: new Date().toISOString(), mandate: input.mandate, closingDate: input.closingDate, excelPath: result.excelPath,
        targetDir: input.targetDir, counts: result.summary.counts, coverage: result.summary.coverage, documents: result.documents.length,
      };
      writeJson('history.json', [entry, ...history().filter(h => h.excelPath !== entry.excelPath)].slice(0, 50));
      writeJson(`result-${currentRunId}.json`, result);
      allowPreviewFor(result);
      if (settings().notifications && Notification.isSupported() && !win?.isFocused()) {
        const n = new Notification({ title: 'Prüfung abgeschlossen', body: `${input.mandate}: ${result.summary.counts.BELEGT} belegt, ${result.summary.counts.PRUEFEN} prüfen, ${result.summary.counts.KEIN_NACHWEIS} ohne Nachweis.`, icon: res('build', 'icon.png') });
        n.on('click', showWindow);
        n.show();
      }
      return { ...result, historyId: currentRunId };
    } finally {
      currentRunId = null;
      resetActivity();
    }
  });
  ipcMain.handle('engine:cancel', () => {
    engine?.kill();
    engine = null;
  });
  ipcMain.handle('app:openPath', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('app:showInFolder', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('app:copyText', (_e, t: string) => clipboard.writeText(t));
  ipcMain.handle('app:history', () => history());
  ipcMain.handle('app:removeHistory', (_e, id: string) => {
    const h = history().filter(x => x.id !== id);
    writeJson('history.json', h);
    updateTray();
    return h;
  });
  ipcMain.handle('app:loadResult', (_e, id: string) => {
    const r = readJson<unknown>(`result-${id}.json`, null);
    allowPreviewFor(r);
    return r;
  });
  ipcMain.handle('engine:filePreview', async (_e, p: string, page: number) => {
    const abs = path.resolve(p);
    if (!previewAllowed.has(abs)) throw new Error('Vorschau nur für Belege der geöffneten Prüfung.');
    if (!existsSync(abs)) throw new Error('Datei nicht mehr vorhanden (verschoben oder gelöscht).');
    const key = `${abs}#${page}`;
    if (previewCache.has(key)) return previewCache.get(key);
    const pv = await call<unknown>({ type: 'preview', absPath: abs, page });
    previewCache.set(key, pv);
    if (previewCache.size > 40) previewCache.delete(previewCache.keys().next().value!);
    return pv;
  });
  ipcMain.handle('app:settings', () => settings());
  ipcMain.handle('app:saveSettings', (_e, s: Partial<AppSettings>) => {
    const next = { ...settings(), ...s };
    writeJson('settings.json', next);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.autoStart, args: ['--hidden'] });
    updateTray();
    return next;
  });
  ipcMain.handle('app:version', () => app.getVersion());
}

app.on('second-instance', showWindow);
// ------------------------------------------------------------------ Geordnetes Beenden
// Unter Windows bleiben Hilfsprozesse von Electron (Grafik, Fensterinhalt, Prüf-Engine) zurück,
// wenn der Hauptprozess abrupt endet. Deshalb: Engine beenden und abwarten, Fenster schliessen,
// und notfalls alle eigenen Prozesse einzeln beenden, bevor die App sich beendet.
let shuttingDown = false;
const qlog = (m: string) => console.log(`[beenden] ${m}`);

function stopEngine(): Promise<void> {
  const p = engine;
  engine = null;
  if (!p) return Promise.resolve();
  return new Promise(resolve => {
    const t = setTimeout(resolve, 2000);
    p.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.kill();
  });
}

function killHelperProcesses(): void {
  for (const m of app.getAppMetrics()) {
    if (m.pid === process.pid) continue;
    try {
      process.kill(m.pid);
      qlog(`Hilfsprozess ${m.type} (${m.pid}) beendet`);
    } catch {
      /* bereits beendet */
    }
  }
}

app.on('before-quit', e => {
  quitting = true;
  if (shuttingDown) return;
  e.preventDefault();
  shuttingDown = true;
  qlog('gestartet');
  // Notfall: spätestens nach 5 s alle Prozesse beenden
  const hard = setTimeout(() => {
    qlog('Zeitüberschreitung – beende alle Prozesse');
    killHelperProcesses();
    app.exit(0);
  }, 5000);
  void (async () => {
    await stopEngine();
    qlog('Prüf-Engine beendet');
    tray?.destroy();
    tray = null;
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    qlog('Fenster geschlossen');
    clearTimeout(hard);
    app.quit(); // zweiter Aufruf: shuttingDown = true -> normales Beenden
  })();
});
app.on('will-quit', () => qlog('will-quit'));
app.on('quit', () => {
  qlog('quit');
  killHelperProcesses();
});

app.on('window-all-closed', () => {
  if (!settings().autoStart) app.quit();
});

void app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((d, cb) =>
    cb({
      responseHeaders: {
        ...d.responseHeaders,
        'Content-Security-Policy': [isDev ? "default-src 'self' 'unsafe-inline' http://localhost:5173 ws://localhost:5173" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'"],
      },
    }),
  );
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  registerIpc();
  createWindow();
  const img = nativeImage.createFromPath(res('build', 'tray.png'));
  tray = new Tray(img);
  tray.on('click', () => (win?.isVisible() ? win.hide() : showWindow()));
  updateTray();
});
