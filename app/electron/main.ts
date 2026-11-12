import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, session, shell, utilityProcess, type UtilityProcess } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, CloudLocation, HistoryEntry, JobInput, PickedPath, Progress, ReviewDecisions, SignConvention, TbPreview, TbPreviewOptions, FxRateList } from './shared';
import { execFile } from 'node:child_process';

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let activity: string | null = null;

// Eigener Daten- und Sperrordner, damit sich die lokale App nicht mit der früheren
// Server-Variante "Balance Scout" (gleicher Name) in die Quere kommt: Diese läuft oft im
// Infobereich weiter und würde sonst beim Start statt der lokalen App angezeigt.
app.setName('Balance Scout Lokal');
app.setPath('userData', path.join(app.getPath('appData'), 'Balance Scout Lokal'));
if (!app.isPackaged && process.env.BSB_USER_DATA) app.setPath('userData', process.env.BSB_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('ch.balancescout.lokal');

// ------------------------------------------------------------------ Pfade
const res = (...p: string[]) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '..', ...p));
const enginePath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'node_modules', '@balance-scout', 'engine', 'dist', 'runner.js')
    : path.join(__dirname, '..', 'node_modules', '@balance-scout', 'engine', 'dist', 'runner.js');
const tessdata = () => (app.isPackaged ? path.join(process.resourcesPath, 'tessdata') : path.join(__dirname, '..', 'node_modules', '@balance-scout', 'engine', 'tessdata'));
const userFile = (n: string) => path.join(app.getPath('userData'), n);

// ------------------------------------------------------------------ Einstellungen & Verlauf
const DEFAULTS: AppSettings = { defaultTargetBase: '', fileMode: 'copy', toleranceChf: '1.00', signConvention: 'signed', notifications: true, autoStart: false, visum: '', groupLetters: null, accountDigits: null, fxRateLists: {} };
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
type RunOut = { excelPath: string; summary: { counts: Record<string, number>; coverage: number }; documents: unknown[] };
type GroupsInfo = { groups: { code: string; name: string; category: string; subcategory: string }[]; letters: Record<string, string> };
let groupsCache: Promise<GroupsInfo> | null = null;

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

// ------------------------------------------------------------------ Cloud-Ordner (OneDrive / SharePoint)
/**
 * Findet die auf diesem PC synchronisierten OneDrive- und SharePoint-Ordner.
 * Quellen: Umgebungsvariablen von OneDrive und die Registry des OneDrive-Clients
 * (HKCU\Software\SyncEngines\Providers\OneDrive\*\MountPoint = synchronisierte Bibliotheken).
 */
function cloudLocations(): Promise<CloudLocation[]> {
  const out: CloudLocation[] = [];
  const add = (label: string, p: string | undefined, kind: CloudLocation['kind']) => {
    if (p && existsSync(p) && !out.some(o => o.path.toLowerCase() === p.toLowerCase())) out.push({ label, path: p, kind });
  };
  if (process.env.OneDriveCommercial) add(path.basename(process.env.OneDriveCommercial), process.env.OneDriveCommercial, 'onedrive');
  if (!app.isPackaged && process.env.BSB_CLOUD_ROOTS) {
    for (const p of process.env.BSB_CLOUD_ROOTS.split(path.delimiter)) add(path.basename(p), p, 'sharepoint');
  }
  if (process.platform !== 'win32') return Promise.resolve(out);
  return new Promise(resolve => {
    execFile('reg', ['query', 'HKCU\\Software\\SyncEngines\\Providers\\OneDrive', '/s', '/v', 'MountPoint'], { windowsHide: true, timeout: 5000 }, (_err, stdout) => {
      for (const m of String(stdout ?? '').matchAll(/MountPoint\s+REG_\w+\s+(.+)/g)) {
        const p = m[1]!.trim();
        const org = path.basename(path.dirname(p));
        add(`${org} – ${path.basename(p)}`, p, 'sharepoint');
      }
      if (process.env.OneDriveConsumer && process.env.OneDriveConsumer !== process.env.OneDriveCommercial) add('OneDrive (privat)', process.env.OneDriveConsumer, 'onedrive');
      resolve(out);
    });
  });
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
  // Nach dem Abschluss: abgelegte Kopien (mit Register-Präfix) und Notiz-PDFs
  const filed = (result as { filed?: Record<string, { placement?: { newPath?: string | null } | null; notePath?: string | null }> } | null)?.filed ?? {};
  for (const f of Object.values(filed)) {
    if (f.placement?.newPath) previewAllowed.add(path.resolve(f.placement.newPath));
    if (f.notePath) previewAllowed.add(path.resolve(f.notePath));
  }
}

// ------------------------------------------------------------------ Fenster & Taskleiste
function createWindow(): void {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1050, minHeight: 680, show: false, title: 'Balance Scout',
    icon: res('build', 'icon.png'), backgroundColor: '#0b1015',
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
        ? [{ type: 'separator' as const }, { label: 'Letzte Prüfungen', enabled: false }, ...recent.map(h => ({ label: `   ${h.mandate}`, click: () => (h.excelPath ? void shell.openPath(h.excelPath) : showWindow()) }))]
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
  ipcMain.handle('pick:cloudLocations', () => cloudLocations());
  ipcMain.handle('pick:trialBalance', async (_e, defaultPath?: string) => {
    if (e2ePicks) return asPicked(e2ePicks.trialBalance as string);
    const r = await dialog.showOpenDialog(win!, { title: 'Saldobilanz wählen', defaultPath, properties: ['openFile'], filters: [{ name: 'Saldobilanz', extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'pdf'] }] });
    return r.canceled || !r.filePaths[0] ? null : asPicked(r.filePaths[0]);
  });
  ipcMain.handle('pick:evidence', async (_e, kind: 'files' | 'folders', defaultPath?: string) => {
    if (e2ePicks) return (e2ePicks[kind] as string[]).map(asPicked);
    const r = await dialog.showOpenDialog(win!, {
      title: kind === 'folders' ? 'Ordner mit Kundenunterlagen wählen' : 'Belege wählen',
      defaultPath,
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

  ipcMain.handle('engine:preview', (_e, p: string | string[], sign: SignConvention, opts?: TbPreviewOptions | TbPreview['detected']) => {
    // Kompatibel: drittes Argument = Spaltenzuordnung (eine Datei) oder Optionen
    const o: TbPreviewOptions = opts && 'mapping' in opts && typeof (opts as { headerRowIndex?: number }).headerRowIndex === 'number' ? { mapping: opts as TbPreview['detected'] } : ((opts ?? {}) as TbPreviewOptions);
    return call<TbPreview>({
      type: 'previewTrialBalance', paths: Array.isArray(p) ? p : [p], signConvention: sign, mapping: o.mapping ?? undefined,
      mappings: o.mappings ?? undefined, accountDigits: o.accountDigits ?? undefined, skipZeroBalances: o.skipZeroBalances || undefined, partRoles: o.partRoles ?? undefined, ocr: { langPath: tessdata() },
    });
  });
  ipcMain.handle('engine:run', async (_e, input: JobInput) => {
    if (currentRunId) throw new Error('Es läuft bereits eine Prüfung.');
    currentRunId = randomUUID();
    const reportDir = input.targetDir ?? path.dirname(input.trialBalancePath);
    try {
      // Schritt 1: nur analysieren. Ablage und Excel folgen nach der Durchsicht ("Abschliessen").
      const result = await call<RunOut>({
        type: 'run', reportDir, snapshotPath: userFile(`snapshot-${currentRunId}.json`), input: { ...input, ocr: { langPath: tessdata() } },
      });
      const entry: HistoryEntry = {
        id: currentRunId, at: new Date().toISOString(), mandate: input.mandate, closingDate: input.closingDate, excelPath: '',
        targetDir: input.targetDir, counts: result.summary.counts, coverage: result.summary.coverage, documents: result.documents.length, finalized: false,
      };
      writeJson('history.json', [entry, ...history()].slice(0, 50));
      writeJson(`result-${currentRunId}.json`, { ...result, input, decisions: {} });
      allowPreviewFor(result);
      if (settings().notifications && Notification.isSupported() && !win?.isFocused()) {
        const n = new Notification({ title: 'Analyse abgeschlossen – bitte durchsehen', body: `${input.mandate}: ${result.summary.counts.BELEGT} belegt, ${result.summary.counts.PRUEFEN} prüfen, ${result.summary.counts.KEIN_NACHWEIS} ohne Nachweis.`, icon: res('build', 'icon.png') });
        n.on('click', showWindow);
        n.show();
      }
      return { ...result, input, decisions: {}, historyId: currentRunId };
    } finally {
      currentRunId = null;
      resetActivity();
    }
  });
  // Entscheide der Prüferin / des Prüfers laufend speichern (überlebt Neustart)
  ipcMain.handle('review:save', (_e, id: string, decisions: ReviewDecisions) => {
    const r = readJson<Record<string, unknown> | null>(`result-${id}.json`, null);
    if (!r) throw new Error('Prüfung nicht gefunden.');
    writeJson(`result-${id}.json`, { ...r, decisions });
    return true;
  });
  // Vertiefte Prüfung Forderungen: Fälligkeitsanalyse (Anzeige) bzw. Export als Excel
  ipcMain.handle('review:receivables', (_e, id: string, params: Record<string, unknown>) => {
    if (!existsSync(userFile(`snapshot-${id}.json`))) throw new Error('Analysedaten fehlen – bitte die Prüfung erneut starten.');
    return call<unknown>({ type: 'receivables', snapshotPath: userFile(`snapshot-${id}.json`), ...params });
  });
  ipcMain.handle('review:exportReceivables', async (_e, id: string, params: Record<string, unknown>, suggestedName: string, format: 'xlsx' | 'pptx' = 'xlsx') => {
    const saved = readJson<{ input?: JobInput } | null>(`result-${id}.json`, null);
    const r = await dialog.showSaveDialog(win!, {
      title: 'Fälligkeitsanalyse speichern', defaultPath: path.join(saved?.input?.targetDir ?? app.getPath('documents'), suggestedName),
      filters: [format === 'pptx' ? { name: 'PowerPoint', extensions: ['pptx'] } : { name: 'Excel', extensions: ['xlsx'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await call<unknown>({ type: 'receivables', snapshotPath: userFile(`snapshot-${id}.json`), ...params, exportPath: r.filePath, exportFormat: format });
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  // ESTV-Kursliste per 31.12. einmal jährlich laden; gespeichert je Stichtag in den Einstellungen
  ipcMain.handle('rates:import', async () => {
    const testFile = e2ePicks?.rates as string | undefined;
    const r = testFile ? { canceled: false, filePaths: [testFile] } : await dialog.showOpenDialog(win!, { title: 'ESTV-Kursliste (PDF) wählen', filters: [{ name: 'PDF', extensions: ['pdf'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const list = await call<FxRateList>({ type: 'rates', path: r.filePaths[0] });
    if (!list.date) throw new Error('Stichtag der Kursliste nicht erkannt.');
    const lists = { ...settings().fxRateLists, [list.date]: { ...list, importedAt: new Date().toISOString() } };
    writeJson('settings.json', { ...settings(), fxRateLists: lists });
    return lists;
  });
  // Vertiefte Prüfung Sachanlagen: Anlagespiegel (Anzeige) bzw. Export als Excel
  ipcMain.handle('review:fixedAssets', (_e, id: string, params: Record<string, unknown>) => {
    if (!existsSync(userFile(`snapshot-${id}.json`))) throw new Error('Analysedaten fehlen – bitte die Prüfung erneut starten.');
    return call<unknown>({ type: 'fixedAssets', snapshotPath: userFile(`snapshot-${id}.json`), ...params });
  });
  ipcMain.handle('review:exportFixedAssets', async (_e, id: string, params: Record<string, unknown>, suggestedName: string) => {
    const saved = readJson<{ input?: JobInput } | null>(`result-${id}.json`, null);
    const r = await dialog.showSaveDialog(win!, { title: 'Anlagespiegel speichern', defaultPath: path.join(saved?.input?.targetDir ?? app.getPath('documents'), suggestedName), filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (r.canceled || !r.filePath) return null;
    await call<unknown>({ type: 'fixedAssets', snapshotPath: userFile(`snapshot-${id}.json`), ...params, exportPath: r.filePath });
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  ipcMain.handle('review:groups', () => (groupsCache ??= call<GroupsInfo>({ type: 'groups' })));
  // Schritt 2: Abschliessen – Ablage mit Register, Notizen, Excel
  ipcMain.handle('review:finalize', async (_e, id: string, decisions: ReviewDecisions) => {
    if (currentRunId) throw new Error('Es läuft bereits eine Prüfung.');
    const saved = readJson<(RunOut & { input: JobInput }) | null>(`result-${id}.json`, null);
    if (!saved?.input) throw new Error('Prüfung nicht gefunden.');
    if (!existsSync(userFile(`snapshot-${id}.json`))) throw new Error('Analysedaten fehlen – bitte die Prüfung erneut starten.');
    currentRunId = id;
    const input = saved.input;
    try {
      const result = await call<RunOut>({
        type: 'finalize', snapshotPath: userFile(`snapshot-${id}.json`), decisions, targetDir: input.targetDir, fileMode: input.fileMode,
        reportDir: input.targetDir ?? path.dirname(input.trialBalancePath),
      });
      // Analyse-Ergebnis (Original) bleibt die Grundlage der Anzeige; vom Abschluss kommen Ablage, Register und Excel
      const fin = result as unknown as Omit<RunOut, 'documents'> & { diagnostics: string; documents: { id: string; placement: unknown; notePath: string | null; register: string | null; irrelevant: boolean }[] };
      const filed = Object.fromEntries(fin.documents.map(d => [d.id, { placement: d.placement, notePath: d.notePath, register: d.register, irrelevant: d.irrelevant }]));
      const full = { ...saved, excelPath: fin.excelPath, diagnostics: fin.diagnostics, finalized: true, finalizedAt: new Date().toISOString(), filed, finalSummary: fin.summary, decisions };
      writeJson(`result-${id}.json`, full);
      writeJson('history.json', history().map(h => (h.id === id ? { ...h, excelPath: result.excelPath, counts: result.summary.counts, coverage: result.summary.coverage, finalized: true } : h)));
      allowPreviewFor(full);
      updateTray();
      return { ...full, historyId: id };
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
