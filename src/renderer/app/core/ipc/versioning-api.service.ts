import { Injectable } from '@angular/core';

import type { Result } from '../../../../shared/ipc/library-contract';
import type {
  VersioningSetRequest,
  VersioningStateDto,
} from '../../../../shared/ipc/versioning-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.versioning` (ADR 0060). Renderer nie przekazuje sciezek ani komunikatow commitow. */
@Injectable({ providedIn: 'root' })
export class VersioningApiService {
  getState(): Promise<Result<VersioningStateDto>> {
    return callBridge((bridge) => bridge.versioning.get());
  }

  setSettings(settings: VersioningSetRequest): Promise<Result<VersioningStateDto>> {
    return callBridge((bridge) => bridge.versioning.set(settings));
  }
}
