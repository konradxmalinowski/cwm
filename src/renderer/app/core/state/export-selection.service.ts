import { Injectable } from '@angular/core';

/**
 * Zaznaczenie z listy biblioteki przechodzi do widoku eksportu tym kanalem, a nie przez
 * adres: przy wielu elementach fragment URL byloby dlugi, a odswiezenie okna i tak
 * powinno zaczac od czystego wyboru. Widok eksportu odbiera zaznaczenie raz.
 */
@Injectable({ providedIn: 'root' })
export class ExportSelectionService {
  private pending: readonly string[] = [];

  hand(ids: readonly string[]): void {
    this.pending = [...ids];
  }

  take(): readonly string[] {
    const ids = this.pending;
    this.pending = [];
    return ids;
  }
}
