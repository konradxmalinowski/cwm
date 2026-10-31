import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import type { DiagnosticsReport } from '../../../../core/model/diagnostics';
import { formatDate } from '../../core/labels';
import { StartupService } from '../../core/state/startup.service';
import {
  REASON_ADVICE,
  REASON_LABEL,
  baseName,
  rebuildFacts,
  redactPaths,
  safeLocationLabel,
  startupKind,
} from '../../core/state/startup';

const PLATFORM_LABEL: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

@Component({
  selector: 'app-diagnostics',
  templateUrl: './diagnostics.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiagnosticsComponent {
  protected readonly startup = inject(StartupService);
  protected readonly formatDate = formatDate;
  protected readonly locationLabel = safeLocationLabel;

  protected readonly view = computed(() => {
    const state = this.startup.state();
    if (state.status !== 'ready') return null;
    const report = state.report;
    const info = report.index;
    const kind = startupKind(info);
    return {
      report,
      kind,
      sentence: this.sentence(report),
      reasonLabel: info.reason === undefined ? '' : REASON_LABEL[info.reason],
      advice: info.reason === undefined ? '' : REASON_ADVICE[info.reason],
      message: info.message === undefined ? '' : redactPaths(info.message),
      quarantined: info.quarantinedAs === undefined ? '' : baseName(info.quarantinedAs),
      facts: kind === 'rebuilt' ? rebuildFacts(info) : null,
      platform: PLATFORM_LABEL[report.runtime.platform] ?? report.runtime.platform,
    };
  });

  private sentence(report: DiagnosticsReport): string {
    switch (startupKind(report.index)) {
      case 'refused':
        return 'Aplikacja nie otworzyła indeksu przy starcie.';
      case 'rebuilt':
        return 'Indeks był uszkodzony i został odbudowany od nowa.';
      default:
        return report.database.status === 'ok'
          ? 'Indeks otworzył się bez zastrzeżeń i baza odpowiada.'
          : 'Indeks otworzył się przy starcie, ale baza nie odpowiada poprawnie.';
    }
  }

  protected reload(): void {
    void this.startup.load();
  }
}
