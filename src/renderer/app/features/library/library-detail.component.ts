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

import type { ItemDetailDto } from '../../../../shared/ipc/library-contract';
import { LibraryApiService } from '../../core/ipc/library-api.service';
import { formatBytes, formatDate, kindLabel, scopeLabel } from '../../core/labels';
import { ROUTES } from '../../core/routing/route';
import { RouterService } from '../../core/routing/router.service';
import { FlashService } from '../../core/state/flash.service';
import { DeleteDialogComponent } from './delete-dialog.component';

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly item: ItemDetailDto }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

@Component({
  selector: 'app-library-detail',
  imports: [DeleteDialogComponent],
  templateUrl: './library-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryDetailComponent {
  private readonly api = inject(LibraryApiService);
  private readonly router = inject(RouterService);
  protected readonly flash = inject(FlashService);

  readonly id = input.required<string>();

  protected readonly state = signal<DetailState>({ status: 'loading' });
  protected readonly deleting = signal(false);
  protected readonly listHref = `#${ROUTES.library}`;

  protected readonly kindLabel = kindLabel;
  protected readonly scopeLabel = scopeLabel;
  protected readonly formatDate = formatDate;
  protected readonly formatBytes = formatBytes;

  protected readonly editHref = computed(() => `#${ROUTES.libraryEdit(this.id())}`);

  private seq = 0;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected async load(id: string = this.id()): Promise<void> {
    const seq = ++this.seq;
    this.state.set({ status: 'loading' });
    const result = await this.api.get({ id });
    if (seq !== this.seq) return;
    this.state.set(
      result.ok
        ? { status: 'ready', item: result.value }
        : { status: 'error', code: result.error.code, message: result.error.message },
    );
  }

  protected onDeleteClosed(deleted: boolean): void {
    this.deleting.set(false);
    if (deleted) this.router.navigate(ROUTES.library);
  }
}
