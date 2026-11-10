import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import type {
  CandidateDto,
  CandidateStatus,
  ImportApplyDto,
  ImportDetectDto,
  ImportScanDto,
} from '../../../../shared/ipc/import-contract';
import { ImportApiService } from '../../core/ipc/import-api.service';
import { kindLabel, plural } from '../../core/labels';
import { ROUTES } from '../../core/routing/route';
import {
  STATUS_GROUPS,
  defaultRootSelection,
  groupRootsByTool,
  hitLocation,
  isSelectable,
  pathLabel,
  rootKindLabel,
  skipReasonLabel,
  toolLabel,
} from './import-model';
import { SecretConfirmDialogComponent } from './secret-confirm-dialog.component';

type DetectState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: ImportDetectDto };

type Phase = 'locations' | 'scanning' | 'preview' | 'applying' | 'result';

@Component({
  selector: 'app-import-wizard',
  imports: [SecretConfirmDialogComponent],
  templateUrl: './import-wizard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class ImportWizardComponent {
  private readonly api = inject(ImportApiService);

  protected readonly libraryHref = `#${ROUTES.library}`;
  protected readonly toolLabel = toolLabel;
  protected readonly rootKindLabel = rootKindLabel;
  protected readonly kindLabel = kindLabel;
  protected readonly pathLabel = pathLabel;
  protected readonly skipReasonLabel = skipReasonLabel;
  protected readonly hitLocation = hitLocation;
  protected readonly isSelectable = isSelectable;

  protected readonly phase = signal<Phase>('locations');
  protected readonly detect = signal<DetectState>({ status: 'loading' });
  protected readonly pickedRoots = signal<ReadonlySet<string>>(new Set());
  protected readonly scanError = signal<string | null>(null);
  protected readonly scan = signal<ImportScanDto | null>(null);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly confirmedSecrets = signal<ReadonlySet<string>>(new Set());
  protected readonly confirming = signal<CandidateDto | null>(null);
  protected readonly applyError = signal<string | null>(null);
  protected readonly result = signal<ImportApplyDto | null>(null);

  private seq = 0;

  protected readonly toolGroups = computed(() => {
    const state = this.detect();
    return state.status === 'ready' ? groupRootsByTool(state.data.roots) : [];
  });

  protected readonly rootCount = computed(() => {
    const state = this.detect();
    return state.status === 'ready' ? state.data.roots.length : 0;
  });

  protected readonly existingCount = computed(() => {
    const state = this.detect();
    return state.status === 'ready' ? state.data.roots.filter((r) => r.exists).length : 0;
  });

  protected readonly pickedCount = computed(() => {
    const state = this.detect();
    if (state.status !== 'ready') return 0;
    const picked = this.pickedRoots();
    return state.data.roots.filter((r) => r.exists && picked.has(r.rootId)).length;
  });

  protected readonly candidates = computed(() => this.scan()?.candidates ?? []);

  private readonly byId = computed(() => new Map(this.candidates().map((c) => [c.candidateId, c])));

  protected readonly groups = computed(() =>
    STATUS_GROUPS.map((meta) => ({
      ...meta,
      items: this.candidates().filter((c) => c.status === meta.status),
    })).filter((group) => group.items.length > 0),
  );

  protected readonly selectableCount = computed(
    () => this.candidates().filter((c) => isSelectable(c)).length,
  );

  protected readonly selectedCount = computed(() => this.selected().size);

  protected readonly overwriteCount = computed(
    () =>
      this.candidates().filter((c) => c.status === 'changed' && this.selected().has(c.candidateId))
        .length,
  );

  protected readonly secretSelectedCount = computed(
    () =>
      this.candidates().filter((c) => c.secrets.length > 0 && this.selected().has(c.candidateId))
        .length,
  );

  protected readonly sentence = computed(() => {
    switch (this.phase()) {
      case 'locations': {
        const state = this.detect();
        if (state.status === 'loading') return 'Szukam lokalizacji narzędzi.';
        if (state.status === 'error') return 'Nie udało się sprawdzić lokalizacji.';
        if (state.data.roots.length === 0) {
          return 'Aplikacja nie znalazła żadnego katalogu Claude Code ani Codeksa.';
        }
        if (this.existingCount() === 0) {
          return 'Żaden z katalogów narzędzi nie istnieje na tym komputerze.';
        }
        return 'Wybierz, z których lokalizacji zaimportować elementy.';
      }
      case 'scanning':
        return 'Skanuję wybrane lokalizacje.';
      case 'preview': {
        const n = this.candidates().length;
        if (n === 0) return 'Skan nie znalazł niczego do zaimportowania.';
        if (this.selectableCount() === 0) {
          return 'Nic z tego, co znaleziono, nie nadaje się do importu.';
        }
        return `Skan znalazł ${n} ${plural(n, 'element', 'elementy', 'elementów')}. Zdecyduj, co wchodzi do biblioteki.`;
      }
      case 'applying':
        return 'Importuję wybrane elementy.';
      case 'result': {
        const r = this.result();
        if (r === null) return '';
        const n = r.imported.length;
        if (n === 0) return 'Nic nie zostało zaimportowane.';
        return `Zaimportowano ${n} ${plural(n, 'element', 'elementy', 'elementów')} do biblioteki.`;
      }
    }
  });

  protected readonly stepLabel = computed(() => {
    switch (this.phase()) {
      case 'locations':
      case 'scanning':
        return 'Import, krok 1 z 3: lokalizacje';
      case 'preview':
      case 'applying':
        return 'Import, krok 2 z 3: podgląd';
      case 'result':
        return 'Import, krok 3 z 3: wynik';
    }
  });

  /** Liczby statusow do zdania pod tytulem podgladu: tylko niezerowe. */
  protected readonly statusSummary = computed(() => {
    const parts = this.groups().map((g) => `${g.title.toLowerCase()}: ${g.items.length}`);
    const skipped = this.scan()?.skipped.length ?? 0;
    if (skipped > 0) parts.push(`pominięte przy skanie: ${skipped}`);
    return parts.join(', ');
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.seq++;
    });

    // Po zmianie kroku fokus idzie na zdanie, zeby czytnik ekranu i klawiatura wiedzialy,
    // ze tresc sie zmienila. Pierwszy krok jest wolny od tego, bo fokus ustawia router.
    let first = true;
    effect(() => {
      this.phase();
      if (first) {
        first = false;
        return;
      }
      setTimeout(() => document.getElementById('import-heading')?.focus(), 0);
    });

    void this.loadDetect();
  }

  protected async loadDetect(): Promise<void> {
    const seq = ++this.seq;
    this.detect.set({ status: 'loading' });
    const result = await this.api.detect();
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.detect.set({ status: 'error', message: result.error.message });
      return;
    }
    this.detect.set({ status: 'ready', data: result.value });
    this.pickedRoots.set(defaultRootSelection(result.value.roots));
  }

  // ---- Krok 1 ----

  protected toggleRoot(rootId: string, checked: boolean): void {
    const next = new Set(this.pickedRoots());
    if (checked) next.add(rootId);
    else next.delete(rootId);
    this.pickedRoots.set(next);
  }

  protected async startScan(): Promise<void> {
    const state = this.detect();
    if (state.status !== 'ready' || this.pickedCount() === 0) return;
    const rootIds = state.data.roots
      .filter((r) => r.exists && this.pickedRoots().has(r.rootId))
      .map((r) => r.rootId);
    const seq = ++this.seq;
    this.scanError.set(null);
    this.phase.set('scanning');
    const result = await this.api.scan({ rootIds });
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.scanError.set(result.error.message);
      this.phase.set('locations');
      return;
    }
    this.scan.set(result.value);
    // Zmienione elementy zostaja odznaczone mimo `selectedByDefault`: nadpisanie wersji w
    // bibliotece wymaga swiadomego wyboru, a grupa "Zmienione" mowi uzytkownikowi, ze jest
    // domyslnie pominieta. Zaznaczenie bez jego wiedzy byloby nadpisaniem po cichu.
    this.selected.set(
      new Set(
        result.value.candidates
          .filter(
            (c) =>
              c.selectedByDefault &&
              c.status !== 'changed' &&
              c.secrets.length === 0 &&
              isSelectable(c),
          )
          .map((c) => c.candidateId),
      ),
    );
    this.confirmedSecrets.set(new Set());
    this.confirming.set(null);
    this.applyError.set(null);
    this.phase.set('preview');
  }

  /** Skanu nie da sie przerwac po stronie main, ale jego wynik mozna odrzucic. */
  protected cancelScan(): void {
    this.seq++;
    this.phase.set('locations');
  }

  // ---- Krok 2 ----

  protected backToLocations(): void {
    this.seq++;
    this.phase.set('locations');
  }

  protected isSelected(candidate: CandidateDto): boolean {
    return this.selected().has(candidate.candidateId);
  }

  protected duplicateTarget(candidate: CandidateDto): CandidateDto | null {
    return candidate.duplicateOf === null ? null : (this.byId().get(candidate.duplicateOf) ?? null);
  }

  protected itemHref(id: string): string {
    return `#${ROUTES.libraryItem(id)}`;
  }

  protected onPick(candidate: CandidateDto, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.checked) {
      this.deselect(candidate.candidateId);
      return;
    }
    if (candidate.secrets.length > 0 && !this.confirmedSecrets().has(candidate.candidateId)) {
      // Pole zostaje odznaczone, dopoki uzytkownik nie potwierdzi w oknie.
      input.checked = false;
      this.confirming.set(candidate);
      return;
    }
    this.select(candidate.candidateId);
  }

  protected confirmSecret(): void {
    const candidate = this.confirming();
    if (candidate === null) return;
    this.confirmedSecrets.set(new Set(this.confirmedSecrets()).add(candidate.candidateId));
    this.select(candidate.candidateId);
    this.confirming.set(null);
    setTimeout(() => document.getElementById(this.pickId(candidate))?.focus(), 0);
  }

  protected cancelSecret(): void {
    const candidate = this.confirming();
    this.confirming.set(null);
    if (candidate !== null) {
      setTimeout(() => document.getElementById(this.pickId(candidate))?.focus(), 0);
    }
  }

  private select(id: string): void {
    this.selected.set(new Set(this.selected()).add(id));
  }

  private deselect(id: string): void {
    const selected = new Set(this.selected());
    selected.delete(id);
    this.selected.set(selected);
    const confirmed = new Set(this.confirmedSecrets());
    confirmed.delete(id);
    this.confirmedSecrets.set(confirmed);
  }

  /** Zaznacza w grupie wszystko, co mozna zaznaczyc bez osobnej decyzji. Sekrety zostaja odznaczone. */
  protected selectGroup(status: CandidateStatus): void {
    const next = new Set(this.selected());
    for (const c of this.candidates()) {
      if (c.status === status && isSelectable(c) && c.secrets.length === 0) next.add(c.candidateId);
    }
    this.selected.set(next);
  }

  protected clearGroup(status: CandidateStatus): void {
    for (const c of this.candidates()) {
      if (c.status === status) this.deselect(c.candidateId);
    }
  }

  protected groupSelectedCount(status: CandidateStatus): number {
    return this.candidates().filter(
      (c) => c.status === status && this.selected().has(c.candidateId),
    ).length;
  }

  protected groupSecretHeldBack(status: CandidateStatus): number {
    return this.candidates().filter(
      (c) =>
        c.status === status &&
        isSelectable(c) &&
        c.secrets.length > 0 &&
        !this.selected().has(c.candidateId),
    ).length;
  }

  protected groupSelectableCount(status: CandidateStatus): number {
    return this.candidates().filter((c) => c.status === status && isSelectable(c)).length;
  }

  protected pickId(candidate: CandidateDto): string {
    return `pick-${candidate.candidateId}`;
  }

  protected titleId(candidate: CandidateDto): string {
    return `cand-title-${candidate.candidateId}`;
  }

  protected async apply(): Promise<void> {
    const scan = this.scan();
    if (scan === null || this.selectedCount() === 0 || this.phase() !== 'preview') return;
    const ids = this.candidates()
      .filter((c) => this.selected().has(c.candidateId))
      .map((c) => c.candidateId);
    const confirmed = ids.filter((id) => this.confirmedSecrets().has(id));
    const replace = this.candidates()
      .filter((c) => c.status === 'changed' && this.selected().has(c.candidateId))
      .map((c) => c.candidateId);
    const seq = ++this.seq;
    this.applyError.set(null);
    this.phase.set('applying');
    const result = await this.api.apply({
      scanToken: scan.scanToken,
      candidateIds: ids,
      ...(confirmed.length > 0 ? { confirmedSecrets: confirmed } : {}),
      ...(replace.length > 0 ? { replaceChanged: replace } : {}),
    });
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.applyError.set(result.error.message);
      this.phase.set('preview');
      return;
    }
    this.result.set(result.value);
    this.phase.set('result');
  }

  // ---- Krok 3 ----

  protected titleOf(candidateId: string): string {
    return this.byId().get(candidateId)?.title ?? 'Element spoza podglądu';
  }

  protected candidateOf(candidateId: string): CandidateDto | null {
    return this.byId().get(candidateId) ?? null;
  }

  protected restart(): void {
    this.seq++;
    this.scan.set(null);
    this.result.set(null);
    this.selected.set(new Set());
    this.confirmedSecrets.set(new Set());
    this.scanError.set(null);
    this.applyError.set(null);
    this.phase.set('locations');
    void this.loadDetect();
  }

  /** j / k przesuwaja fokus po polach wyboru kandydatow (DESIGN.md, Klawiatura). Spacja zaznacza natywnie. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== 'j' && event.key !== 'k') return;
    if (this.phase() !== 'preview') return;
    if (document.querySelector('dialog[open]') !== null) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const isTextEntry =
        target.isContentEditable ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox');
      if (isTextEntry) return;
    }
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-cand-pick]'));
    if (rows.length === 0) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'j' ? 1 : -1;
    const next =
      current === -1
        ? step === 1
          ? 0
          : rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, current + step));
    rows[next]?.focus();
  }
}
