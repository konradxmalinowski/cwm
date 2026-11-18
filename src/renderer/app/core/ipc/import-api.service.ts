import { Injectable } from '@angular/core';

import type {
  ImportApplyDto,
  ImportApplyRequest,
  ImportDetectDto,
  ImportScanDto,
  ImportScanGitRequest,
  ImportScanProjectRequest,
  ImportScanRequest,
} from '../../../../shared/ipc/import-contract';
import type { Result } from '../../../../shared/ipc/library-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.import`. Brak handlera po stronie main wraca jako `Result` z bledem. */
@Injectable({ providedIn: 'root' })
export class ImportApiService {
  detect(): Promise<Result<ImportDetectDto>> {
    return callBridge((bridge) => bridge.import.detect());
  }

  scan(request: ImportScanRequest): Promise<Result<ImportScanDto>> {
    return callBridge((bridge) => bridge.import.scan(request));
  }

  scanGit(request: ImportScanGitRequest): Promise<Result<ImportScanDto>> {
    return callBridge((bridge) => bridge.import.scanGit(request));
  }

  scanProject(request: ImportScanProjectRequest): Promise<Result<ImportScanDto>> {
    return callBridge((bridge) => bridge.import.scanProject(request));
  }

  apply(request: ImportApplyRequest): Promise<Result<ImportApplyDto>> {
    return callBridge((bridge) => bridge.import.apply(request));
  }
}
