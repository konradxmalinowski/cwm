import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';

import { RouterService } from './core/routing/router.service';
import { ROUTES } from './core/routing/route';
import { FlashService } from './core/state/flash.service';
import { StartupService } from './core/state/startup.service';
import { ThemeService, type ThemePreference } from './core/theme/theme.service';
import { ExportWizardComponent } from './features/export/export-wizard.component';
import { ImportWizardComponent } from './features/import/import-wizard.component';
import { DiagnosticsComponent } from './features/diagnostics/diagnostics.component';
import { HistoryComponent } from './features/history/history.component';
import { SyncCenterComponent } from './features/sync/sync-center.component';
import { LibraryDetailComponent } from './features/library/library-detail.component';
import { LibraryFormComponent } from './features/library/library-form.component';
import { LibraryListComponent } from './features/library/library-list.component';
import { StartupBannerComponent } from './startup-banner.component';

@Component({
  selector: 'app-root',
  imports: [
    StartupBannerComponent,
    LibraryListComponent,
    LibraryDetailComponent,
    LibraryFormComponent,
    ImportWizardComponent,
    ExportWizardComponent,
    DiagnosticsComponent,
    SyncCenterComponent,
    HistoryComponent,
  ],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly router = inject(RouterService);
  protected readonly theme = inject(ThemeService);

  protected readonly route = this.router.route;
  protected readonly paths = ROUTES;
  protected readonly section = computed(() => {
    const name = this.route().name;
    if (name.startsWith('library')) return 'library';
    if (name === 'import') return 'import';
    if (name === 'export') return 'export';
    if (name === 'diagnostics') return 'diagnostics';
    if (name === 'sync') return 'sync';
    if (name === 'history') return 'history';
    return null;
  });
  protected readonly themeOptions: readonly { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Jasny' },
    { value: 'dark', label: 'Ciemny' },
  ];

  constructor() {
    void inject(StartupService).load();
    const flash = inject(FlashService);

    // Po zmianie widoku fokus idzie na zdanie otwierajace nowy ekran, zeby czytnik ekranu
    // i klawiatura wiedzialy, ze tresc sie zmienila.
    let first = true;
    effect(() => {
      this.route();
      if (first) {
        first = false;
        return;
      }
      flash.onRouteChange();
      setTimeout(() => {
        document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: false });
      }, 0);
    });
  }

  protected skipToContent(): void {
    document.getElementById('main')?.focus();
  }
}
