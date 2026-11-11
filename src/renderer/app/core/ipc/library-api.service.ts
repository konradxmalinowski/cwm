import { Injectable } from '@angular/core';

import type {
  DeletePlanDto,
  ItemDetailDto,
  LibraryDeleteApplyDto,
  LibraryDeleteApplyRequest,
  LibraryDeletePlanRequest,
  LibraryGetRequest,
  LibraryListDto,
  LibraryListRequest,
  LibraryRepairRequest,
  LibrarySaveDto,
  LibrarySaveRequest,
  Result,
} from '../../../../shared/ipc/library-contract';
import { callBridge } from './ipc-call';

/** Typowane metody nad `window.cwm.library`. Nic poza tym plikiem nie zna nazw kanalow. */
@Injectable({ providedIn: 'root' })
export class LibraryApiService {
  list(request: LibraryListRequest): Promise<Result<LibraryListDto>> {
    return callBridge((bridge) => bridge.library.list(request));
  }

  get(request: LibraryGetRequest): Promise<Result<ItemDetailDto>> {
    return callBridge((bridge) => bridge.library.get(request));
  }

  save(request: LibrarySaveRequest): Promise<Result<LibrarySaveDto>> {
    return callBridge((bridge) => bridge.library.save(request));
  }

  deletePlan(request: LibraryDeletePlanRequest): Promise<Result<DeletePlanDto>> {
    return callBridge((bridge) => bridge.library.deletePlan(request));
  }

  deleteApply(request: LibraryDeleteApplyRequest): Promise<Result<LibraryDeleteApplyDto>> {
    return callBridge((bridge) => bridge.library.deleteApply(request));
  }

  repair(request: LibraryRepairRequest): Promise<Result<LibrarySaveDto>> {
    return callBridge((bridge) => bridge.library.repair(request));
  }
}
