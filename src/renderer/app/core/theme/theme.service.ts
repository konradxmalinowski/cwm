import { Injectable, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'uasm.theme';

function readStored(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Pamiec przegladarki bywa niedostepna; wtedy zostaje wybor systemu.
  }
  return 'system';
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
