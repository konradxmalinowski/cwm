import { Injectable, signal } from '@angular/core';

import type { WarningDto } from '../../../../shared/ipc/library-contract';

export interface Flash {
  readonly message: string;
  readonly warnings: readonly WarningDto[];
}

/** Wynik operacji, ktory przezywa przejscie miedzy widokami (zapis, usuniecie, naprawa). */
@Injectable({ providedIn: 'root' })
export class FlashService {
  readonly current = signal<Flash | null>(null);
  private routeChangesLeft = 0;

  /** `navigates`: po pokazaniu komunikatu nastapi jeszcze zmiana widoku, na ktorej ma zostac. */
  show(message: string, warnings: readonly WarningDto[] = [], navigates = false): void {
    this.current.set({ message, warnings });
    this.routeChangesLeft = navigates ? 1 : 0;
  }

  clear(): void {
    this.current.set(null);
    this.routeChangesLeft = 0;
  }

  /** Komunikat jest stary, gdy uzytkownik opuscil widok, na ktorym go zobaczyl. */
  onRouteChange(): void {
    if (this.routeChangesLeft > 0) this.routeChangesLeft--;
    else this.current.set(null);
  }
}
