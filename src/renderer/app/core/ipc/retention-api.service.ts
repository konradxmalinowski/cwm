import { Injectable } from '@angular/core';

import type { Result } from '../../../../shared/ipc/library-contract';
import type {
  RetentionReportDto,
  RetentionSettingsDto,
  RetentionStateDto,
} from '../../../../shared/ipc/retention-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.retention` (ADR 0056). Renderer nie przekazuje sciezek ani hashy. */
@Injectable({ providedIn: 'root' })
export class RetentionApiService {
  getSettings(): Promise<Result<RetentionStateDto>> {
    return callBridge((bridge) => bridge.retention.get());
  }

  /** `confirmed` potwierdza wlaczenie albo zaostrzenie limitu po obejrzeniu podgladu. */
  setSettings(
    settings: RetentionSettingsDto,
    confirmed: boolean,
  ): Promise<Result<RetentionStateDto>> {
    return callBridge((bridge) => bridge.retention.set({ ...settings, confirmed }));
  }

  /** Suchy przebieg: nic nie jest zmieniane. Bez `settings` liczy na zapisanych. */
  preview(settings?: RetentionSettingsDto): Promise<Result<RetentionReportDto>> {
    return callBridge((bridge) =>
      bridge.retention.preview(settings === undefined ? undefined : { settings }),
    );
  }

  apply(token: string): Promise<Result<RetentionReportDto>> {
    return callBridge((bridge) => bridge.retention.apply({ confirmed: true, token }));
  }
}
