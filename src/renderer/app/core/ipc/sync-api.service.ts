import { Injectable } from '@angular/core';

import type {
  SyncApplyDto,
  SyncApplyRequest,
  SyncPlanDto,
  SyncPlanRequest,
  SyncStatusDto,
  SyncStatusRequest,
} from '../../../../shared/ipc/sync-contract';
import type { Result } from '../../../../shared/ipc/library-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.uasm.sync`. Brak handlera po stronie main wraca jako `Result` z bledem. */
@Injectable({ providedIn: 'root' })
export class SyncApiService {
  status(request: SyncStatusRequest): Promise<Result<SyncStatusDto>> {
    return callBridge((bridge) => bridge.sync.status(request));
  }

  plan(request: SyncPlanRequest): Promise<Result<SyncPlanDto>> {
    return callBridge((bridge) => bridge.sync.plan(request));
  }

  apply(request: SyncApplyRequest): Promise<Result<SyncApplyDto>> {
    return callBridge((bridge) => bridge.sync.apply(request));
  }
}
