import { Injectable } from '@angular/core';

import type {
  ExportApplyDto,
  ExportApplyRequest,
  ExportPlanDto,
  ExportPlanRequest,
} from '../../../../shared/ipc/export-contract';
import type { Result } from '../../../../shared/ipc/library-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.export`. Brak handlera po stronie main wraca jako `Result` z bledem. */
@Injectable({ providedIn: 'root' })
export class ExportApiService {
  plan(request: ExportPlanRequest): Promise<Result<ExportPlanDto>> {
    return callBridge((bridge) => bridge.export.plan(request));
  }

  apply(request: ExportApplyRequest): Promise<Result<ExportApplyDto>> {
    return callBridge((bridge) => bridge.export.apply(request));
  }
}
