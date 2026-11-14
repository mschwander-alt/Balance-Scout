/** Darstellung hell / dunkel: sofort aus dem lokalen Speicher (kein Aufblitzen), dauerhaft in den Einstellungen */
import { bsb } from './bridge';

export type Theme = 'dark' | 'light';
const KEY = 'bsb-theme';

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* ohne Speicher: nur für diese Sitzung */ }
}

/** Beim Start: zuletzt gewählte Darstellung (Standard dunkel) */
export function initialTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

export function setTheme(t: Theme): void {
  applyTheme(t);
  void bsb().app.saveSettings({ theme: t });
}
