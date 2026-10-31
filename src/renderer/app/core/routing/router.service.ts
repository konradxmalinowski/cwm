import { Injectable, signal } from '@angular/core';

import { parseRoute, type Route } from './route';

/**
 * Router na fragmencie adresu. Protokol `app://` serwuje wszystko spod jednego
 * `index.html`, a fragment nie wymaga od main zadnej wiedzy o trasach. Angular Router
 * nie jest zaleznoscia projektu, a dwie trasy z parametrem nie uzasadniaja nowej.
 */
@Injectable({ providedIn: 'root' })
export class RouterService {
  readonly route = signal<Route>(parseRoute(window.location.hash));

  constructor() {
    window.addEventListener('hashchange', () => {
      this.route.set(parseRoute(window.location.hash));
    });
  }

  navigate(path: string): void {
    window.location.hash = path;
  }
}
