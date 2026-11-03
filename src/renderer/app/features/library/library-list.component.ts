import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import type {
  InconsistentDto,
  ItemKindDto,
  LibraryListDto,
  ProblemDto,
  RepairAction,
} from '../../../../shared/ipc/library-contract';
import { LibraryApiService } from '../../core/ipc/library-api.service';
import { ITEM_KINDS, fileProblemLabel, formatDate, kindLabel, plural } from '../../core/labels';
import { ROUTES } from '../../core/routing/route';
import { FlashService } from '../../core/state/flash.service';
import { DeleteDialogComponent } from './delete-dialog.component';

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: LibraryListDto }
  | { readonly status: 'error'; readonly message: string };

const SEARCH_DEBOUNCE_MS = 250;

@Component({
  selector: 'app-library-list',
  imports: [DeleteDialogComponent],
  templateUrl: './library-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class LibraryListComponent {
  private readonly api = inject(LibraryApiService);
  protected readonly flash = inject(FlashService);

  protected readonly kinds = ITEM_KINDS;
  protected readonly newHref = `#${ROUTES.libraryNew}`;
  protected readonly importHref = `#${ROUTES.import}`;
  protected readonly kindLabel = kindLabel;
  protected readonly fileProblemLabel = fileProblemLabel;
  protected readonly formatDate = formatDate;

  protected readonly state = signal<ListState>({ status: 'loading' });
  protected readonly refreshing = signal(false);
  protected readonly query = signal('');
  protected readonly kind = signal<ItemKindDto | ''>('');
  protected readonly repairing = signal<string | null>(null);
  protected readonly repairError = signal<{ id: string; message: string } | null>(null);
  protected readonly deleting = signal<string | null>(null);

  private requestSeq = 0;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  protected readonly filtered = computed(() => this.query().trim() !== '' || this.kind() !== '');

  protected readonly summary = computed(() => {
    const state = this.state();
    if (state.status !== 'ready') return null;
    const { items, problems, inconsistent } = state.data;
    const n = items.length;
    const noun = plural(n, 'element', 'elementy', 'elementów');
    const sentence = this.filtered()
      ? n === 0
        ? 'Nic nie pasuje do tego zapytania.'
        : `Do zapytania ${plural(n, 'pasuje', 'pasują', 'pasuje')} ${n} ${noun}.`
      : n === 0 && problems.length === 0 && inconsistent.length === 0
        ? 'Biblioteka jest pusta.'
        : `W bibliotece ${plural(n, 'jest', 'są', 'jest')} ${n} ${noun}.`;
    const attention = inconsistent.length + problems.length;
    const parts: string[] = [];
    if (inconsistent.length > 0) {
      parts.push(
        `${inconsistent.length} ${plural(inconsistent.length, 'niespójny', 'niespójne', 'niespójnych')}`,
      );
    }
    if (problems.length > 0) {
      parts.push(
        `${problems.length} ${plural(problems.length, 'nieczytelny', 'nieczytelne', 'nieczytelnych')}`,
      );
    }
    return { n, sentence, attention, attentionText: parts.join(', ') };
  });

  protected readonly isEmptyLibrary = computed(() => {
    const state = this.state();
    return (
      state.status === 'ready' &&
      !this.filtered() &&
      state.data.items.length === 0 &&
      state.data.problems.length === 0 &&
      state.data.inconsistent.length === 0
    );
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.debounce);
      this.requestSeq++;
    });
    void this.load();
  }

  protected itemHref(id: string): string {
    return `#${ROUTES.libraryItem(id)}`;
  }

  protected inconsistentTitle(entry: InconsistentDto): string {
    return entry.slug ?? 'Element bez odczytanej nazwy';
  }

  protected problemTitle(entry: ProblemDto): string {
    return `Element ${entry.id}`;
  }

  protected async load(): Promise<void> {
    const seq = ++this.requestSeq;
    this.refreshing.set(true);
    const query = this.query().trim();
    const kind = this.kind();
    const result = await this.api.list({
      ...(query === '' ? {} : { query }),
      ...(kind === '' ? {} : { kind }),
    });
    if (seq !== this.requestSeq) return;
    this.refreshing.set(false);
    this.state.set(
      result.ok
        ? { status: 'ready', data: result.value }
        : { status: 'error', message: result.error.message },
    );
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.load(), SEARCH_DEBOUNCE_MS);
  }

  protected onKind(value: string): void {
    this.kind.set(ITEM_KINDS.some((k) => k.value === value) ? (value as ItemKindDto) : '');
    void this.load();
  }

  protected clearFilters(): void {
    this.query.set('');
    this.kind.set('');
    void this.load();
  }

  protected retry(): void {
    this.state.set({ status: 'loading' });
    void this.load();
  }

  protected async repair(id: string, action: RepairAction): Promise<void> {
    this.repairing.set(id);
    this.repairError.set(null);
    const result = await this.api.repair({ id, action });
    this.repairing.set(null);
    if (!result.ok) {
      this.repairError.set({ id, message: result.error.message });
      return;
    }
    this.flash.show(
      action === 'adopt-disk'
        ? 'Stan z dysku został przyjęty jako nowa wersja elementu.'
        : 'Przywrócono ostatnią zapisaną wersję elementu.',
      result.value.warnings,
    );
    await this.load();
  }

  protected openDelete(id: string): void {
    this.deleting.set(id);
  }

  protected async onDeleteClosed(deleted: boolean): Promise<void> {
    this.deleting.set(null);
    if (deleted) await this.load();
  }

  /** j / k przesuwaja fokus po wierszach, / skacze do wyszukiwania (DESIGN.md, Klawiatura). */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('dialog[open]') !== null) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    ) {
      return;
    }

    if (event.key === '/') {
      event.preventDefault();
      document.getElementById('library-query')?.focus();
      return;
    }
    if (event.key !== 'j' && event.key !== 'k') return;

    const links = Array.from(document.querySelectorAll<HTMLElement>('[data-row-link]'));
    if (links.length === 0) return;
    event.preventDefault();
    const current = links.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'j' ? 1 : -1;
    const next =
      current === -1
        ? step === 1
          ? 0
          : links.length - 1
        : Math.min(links.length - 1, Math.max(0, current + step));
    links[next]?.focus();
  }
}
