import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import type {
  ItemDetailDto,
  ItemDraftDto,
  ItemKindDto,
} from '../../../../shared/ipc/library-contract';
import { LibraryApiService } from '../../core/ipc/library-api.service';
import { ITEM_KINDS, SCOPES } from '../../core/labels';
import { ROUTES } from '../../core/routing/route';
import { RouterService } from '../../core/routing/router.service';
import { FlashService } from '../../core/state/flash.service';

type Scope = 'public' | 'private' | 'project';
type FieldName = 'slug' | 'title' | 'description' | 'body';

const FIELD_ORDER: readonly FieldName[] = ['slug', 'title', 'description', 'body'];

const REQUIRED_MESSAGE: Readonly<Record<FieldName, string>> = {
  slug: 'Podaj slug, czyli krótką nazwę, po której biblioteka rozpozna element.',
  title: 'Podaj tytuł elementu.',
  description: 'Podaj opis elementu.',
  body: 'Wpisz treść elementu.',
};

const MAX_SHORT = 512;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

@Component({
  selector: 'app-library-form',
  templateUrl: './library-form.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryFormComponent {
  private readonly api = inject(LibraryApiService);
  private readonly router = inject(RouterService);
  private readonly flash = inject(FlashService);

  /** Bez `id` formularz tworzy element, z `id` edytuje istniejacy. */
  readonly id = input<string>();

  protected readonly kinds = ITEM_KINDS;
  protected readonly scopes = SCOPES;
  protected readonly listHref = `#${ROUTES.library}`;

  protected readonly load = signal<LoadState>({ status: 'ready' });
  protected readonly kind = signal<ItemKindDto>('skill');
  protected readonly slug = signal('');
  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly body = signal('');
  protected readonly scope = signal<Scope>('private');
  protected readonly errors = signal<Partial<Record<FieldName, string>>>({});
  protected readonly formError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly submitted = signal(false);

  protected readonly editing = computed(() => this.id() !== undefined);
  protected readonly cancelHref = computed(() => {
    const id = this.id();
    return id === undefined ? this.listHref : `#${ROUTES.libraryItem(id)}`;
  });
  protected readonly errorCount = computed(() => Object.keys(this.errors()).length);
  protected readonly heading = signal('Nowy element biblioteki.');

  private declaredName: string | null = null;
  private seq = 0;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        if (id === undefined) {
          this.heading.set('Nowy element biblioteki.');
          this.load.set({ status: 'ready' });
        } else {
          void this.loadItem(id);
        }
      });
    });
  }

  protected async loadItem(id: string = this.id() ?? ''): Promise<void> {
    const seq = ++this.seq;
    this.heading.set('Wczytuję element.');
    this.load.set({ status: 'loading' });
    const result = await this.api.get({ id });
    if (seq !== this.seq) return;
    if (!result.ok) {
      this.heading.set('Nie udało się wczytać elementu.');
      this.load.set({ status: 'error', code: result.error.code, message: result.error.message });
      return;
    }
    this.populate(result.value);
    this.load.set({ status: 'ready' });
  }

  private populate(item: ItemDetailDto): void {
    this.kind.set(item.kind);
    this.slug.set(item.identity.slug);
    this.title.set(item.content.title);
    this.description.set(item.content.description);
    this.body.set(item.content.body);
    this.scope.set(item.scope);
    this.declaredName = item.identity.declaredName;
    this.heading.set(`Edytujesz „${item.content.title}”.`);
  }

  protected value(field: FieldName): string {
    return this[field]();
  }

  protected onInput(field: FieldName, value: string): void {
    this[field].set(value);
    // Po pierwszej probie zapisu blad znika, gdy tylko pole przestaje byc puste.
    if (this.errors()[field] !== undefined && this.check(field) === null)
      this.setError(field, null);
  }

  protected onBlur(field: FieldName): void {
    this.setError(field, this.check(field));
  }

  protected onKind(value: string): void {
    if (ITEM_KINDS.some((k) => k.value === value)) this.kind.set(value as ItemKindDto);
  }

  protected onScope(value: string): void {
    if (SCOPES.some((s) => s.value === value)) this.scope.set(value as Scope);
  }

  private check(field: FieldName): string | null {
    const value = this[field]();
    if (value.trim() === '') return REQUIRED_MESSAGE[field];
    if ((field === 'slug' || field === 'title') && value.length > MAX_SHORT) {
      return `To pole może mieć najwyżej ${MAX_SHORT} znaków.`;
    }
    return null;
  }

  private setError(field: FieldName, message: string | null): void {
    this.errors.update((current) => {
      const next = { ...current };
      if (message === null) delete next[field];
      else next[field] = message;
      return next;
    });
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.submitted.set(true);
    this.formError.set(null);

    const found: Partial<Record<FieldName, string>> = {};
    for (const field of FIELD_ORDER) {
      const message = this.check(field);
      if (message !== null) found[field] = message;
    }
    this.errors.set(found);
    const first = FIELD_ORDER.find((field) => found[field] !== undefined);
    if (first !== undefined) {
      document.getElementById(`field-${first}`)?.focus();
      return;
    }

    const draft: ItemDraftDto = {
      kind: this.kind(),
      slug: this.slug().trim(),
      title: this.title().trim(),
      description: this.description(),
      body: this.body(),
      scope: this.scope(),
      ...(this.editing() ? { declaredName: this.declaredName } : {}),
    };
    const id = this.id();

    this.saving.set(true);
    const result = await this.api.save(id === undefined ? { draft } : { id, draft });
    this.saving.set(false);

    if (!result.ok) {
      this.showServerError(result.error.code, result.error.message);
      return;
    }
    this.flash.show(
      id === undefined ? 'Element został utworzony.' : 'Zmiany zostały zapisane.',
      result.value.warnings,
      true,
    );
    this.router.navigate(ROUTES.libraryItem(result.value.item.id));
  }

  /** Kolizja albo zly format sluga trafiaja przy polu, reszta na gore formularza. */
  private showServerError(code: string, message: string): void {
    if (code.startsWith('slug-')) {
      this.setError('slug', message);
      document.getElementById('field-slug')?.focus();
      return;
    }
    this.formError.set(message);
    document.getElementById('form-error')?.focus();
  }
}
