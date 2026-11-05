import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import type { DiagnosticsReport } from '../../../../core/model/diagnostics';
import { formatDate } from '../../core/labels';
import { DiagnosticsApiService } from '../../core/ipc/diagnostics-api.service';
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
import { describeOutcome, itemsToRestoreText, type RebuildState } from './rebuild-model';

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
  private readonly api = inject(DiagnosticsApiService);
  protected readonly rebuild = signal<RebuildState>({ status: 'idle' });
  protected readonly describeOutcome = describeOutcome;
  protected readonly itemsToRestoreText = itemsToRestoreText;
  protected readonly baseName = baseName;
  protected readonly reasonText = (reason: string): string =>
    (REASON_LABEL as Readonly<Record<string, string>>)[reason] ?? redactPaths(reason);
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
      reason: info.reason ?? null,
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

  protected async openRebuild(): Promise<void> {
    this.rebuild.set({ status: 'planning' });
    const result = await this.api.rebuildIndexPlan();
    this.rebuild.set(
      result.ok
        ? { status: 'plan', plan: result.value, acknowledged: false }
        : { status: 'error', step: 'plan', message: result.error.message },
    );
  }

  protected acknowledge(checked: boolean): void {
    const state = this.rebuild();
    if (state.status === 'plan') this.rebuild.set({ ...state, acknowledged: checked });
  }

  protected cancelRebuild(): void {
    this.rebuild.set({ status: 'idle' });
  }

  protected async applyRebuild(): Promise<void> {
    const state = this.rebuild();
    if (state.status !== 'plan' || !state.acknowledged) return;
    if (state.plan.recoverability === 'blocked') return;
    this.rebuild.set({ status: 'applying', plan: state.plan });
    const result = await this.api.rebuildIndexApply(state.plan.planId);
    if (result.ok) {
      this.rebuild.set({ status: 'done', report: result.value });
      await this.startup.refresh();
    } else {
      this.rebuild.set({ status: 'error', step: 'apply', message: result.error.message });
    }
  }
}
