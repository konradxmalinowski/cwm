import { Injectable, inject, signal } from '@angular/core';

import type { DiagnosticsReport } from '../../../../core/model/diagnostics';
import { DiagnosticsApiService } from '../ipc/diagnostics-api.service';

export type ReportState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly report: DiagnosticsReport }
  | { readonly status: 'error'; readonly message: string };

/** Raport diagnostyczny: jedno zrodlo dla paska startu w powloce i dla widoku Diagnostyka. */
@Injectable({ providedIn: 'root' })
export class StartupService {
  private readonly api = inject(DiagnosticsApiService);

  readonly state = signal<ReportState>({ status: 'loading' });
  readonly bannerDismissed = signal(false);

  async load(): Promise<void> {
    this.state.set({ status: 'loading' });
    const result = await this.api.report();
    this.state.set(
      result.ok
        ? { status: 'ready', report: result.value }
        : { status: 'error', message: result.error.message },
    );
  }

  /** Odswieza raport bez przelaczania widoku na szkielet; blad nie zastepuje poprzedniego raportu. */
  async refresh(): Promise<void> {
    const result = await this.api.report();
    if (result.ok) {
      this.state.set({ status: 'ready', report: result.value });
      this.bannerDismissed.set(false);
    }
  }
}
