import { provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';
import { applyStoredTheme } from './app/core/theme/theme.service';

// Motyw przed pierwszym renderem; inline-owy skrypt w index.html zlamalby CSP.
applyStoredTheme();

void bootstrapApplication(AppComponent, {
  providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection()],
});
