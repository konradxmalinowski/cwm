import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ROUTES } from './core/routing/route';
import { StartupService } from './core/state/startup.service';
import {
  REASON_ADVICE,
  REASON_LABEL,
  baseName,
  rebuildFacts,
  redactPaths,
  startupKind,
} from './core/state/startup';

/**
 * Stan otwarcia indeksu (ADR 0029). Start normalny nie pokazuje nic. Odbudowa i odmowa
 * maja swoj pasek, a zero odbudowanych elementow nie wyglada na sukces.
 */
@Component({
  selector: 'app-startup-banner',
  templateUrl: './startup-banner.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StartupBannerComponent {
  protected readonly startup = inject(StartupService);
  protected readonly diagnosticsHref = `#${ROUTES.diagnostics}`;

  protected readonly view = computed(() => {
    const state = this.startup.state();
    if (state.status === 'loading') return null;
    if (state.status === 'error') return { kind: 'unreadable' as const, message: state.message };

    const info = state.report.index;
    const kind = startupKind(info);
    if (kind === 'normal') return null;

    const reasonLabel = info.reason === undefined ? '' : REASON_LABEL[info.reason];
    const advice = info.reason === undefined ? '' : REASON_ADVICE[info.reason];
    const message = info.message === undefined ? '' : redactPaths(info.message);
    const quarantined = info.quarantinedAs === undefined ? '' : baseName(info.quarantinedAs);

    if (kind === 'refused') {
      return { kind, reasonLabel, advice, message, quarantined };
    }
    return { kind, reasonLabel, quarantined, facts: rebuildFacts(info) };
  });

  protected retry(): void {
    void this.startup.load();
  }

  protected dismiss(): void {
    this.startup.bannerDismissed.set(true);
  }
}
