import { Injectable } from '@angular/core';

import type { Result } from '../../../../shared/ipc/library-contract';
import type {
  RetentionReportDto,
  RetentionSettingsDto,
} from '../../../../shared/ipc/retention-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.retention` (ADR 0056). Renderer nie przekazuje sciezek ani hashy. */
@Injectable({ providedIn: 'root' })
export class RetentionApiService {
  getSettings(): Promise<Result<RetentionSettingsDto>> {
    return callBridge((bridge) => bridge.retention.get());
  }

  setSettings(settings: RetentionSettingsDto): Promise<Result<RetentionSettingsDto>> {
    return callBridge((bridge) => bridge.retention.set(settings));
  }

  /** Suchy przebieg na zapisanych ustawieniach: nic nie jest zmieniane. */
  preview(): Promise<Result<RetentionReportDto>> {
    return callBridge((bridge) => bridge.retention.preview());
  }

  apply(): Promise<Result<RetentionReportDto>> {
    return callBridge((bridge) => bridge.retention.apply({ confirmed: true }));
  }
}
