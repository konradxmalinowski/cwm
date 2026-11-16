import { Injectable } from '@angular/core';

import type {
  ExportApplyDto,
  ExportApplyRequest,
  ExportPlanDto,
  ExportPlanRequest,
  ExportZipPlanDto,
  ExportZipPlanRequest,
  ExportZipSaveDto,
  ExportZipSaveRequest,
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

  /** Plan archiwum ZIP (ADR 0054): ten sam ksztalt co plan eksportu plus nazwa, liczby i elementy poza archiwum. */
  zipPlan(request: ExportZipPlanRequest): Promise<Result<ExportZipPlanDto>> {
    return callBridge((bridge) => bridge.export.zipPlan(request));
  }

  /** Zapis przyjmuje tylko `planId`: miejsce pliku wybiera main systemowym oknem. */
  zipSave(request: ExportZipSaveRequest): Promise<Result<ExportZipSaveDto>> {
    return callBridge((bridge) => bridge.export.zipSave(request));
  }
}
