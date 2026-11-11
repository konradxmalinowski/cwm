import { Injectable, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'cwm.theme';
const LEGACY_STORAGE_KEY = 'uasm.theme';

function readStored(): ThemePreference {
  try {
    let value = window.localStorage.getItem(STORAGE_KEY);
    if (value === null) {
      value = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (value !== null) migrateLegacy(value);
    }
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Pamiec przegladarki bywa niedostepna; wtedy zostaje wybor systemu.
  }
  return 'system';
}

/** Jednorazowe przeniesienie klucza z v0.1.0; niepowodzenie zapisu nie gubi odczytanej wartosci. */
function migrateLegacy(value: string): void {
  try {
    if (value === 'light' || value === 'dark') window.localStorage.setItem(STORAGE_KEY, value);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Przeniesienie zostanie ponowione przy nastepnym starcie.
  }
}

export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }
}

/** Wywolywane przed startem Angulara, zeby pierwsza klatka miala wlasciwy motyw. */
export function applyStoredTheme(): void {
  applyTheme(readStored());
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(readStored());

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    applyTheme(preference);
    try {
      if (preference === 'system') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Wybor dziala w tej sesji, tylko nie przetrwa restartu.
    }
  }
}
