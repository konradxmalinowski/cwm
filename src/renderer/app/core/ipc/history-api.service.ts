import { Injectable } from '@angular/core';

import type { Result } from '../../../../shared/ipc/library-contract';
import type {
  HistoryListDto,
  HistoryListRequest,
  HistoryRollbackDto,
  HistoryRollbackRequest,
} from '../../../../shared/ipc/sync-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.history`. Cofniecie zwraca plan, ktory zapisuje `export.apply`. */
@Injectable({ providedIn: 'root' })
export class HistoryApiService {
  list(request: HistoryListRequest): Promise<Result<HistoryListDto>> {
    return callBridge((bridge) => bridge.history.list(request));
  }

  rollback(request: HistoryRollbackRequest): Promise<Result<HistoryRollbackDto>> {
    return callBridge((bridge) => bridge.history.rollback(request));
  }
}
