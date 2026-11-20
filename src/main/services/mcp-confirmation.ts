import { randomBytes, timingSafeEqual } from 'node:crypto';

import { PLAN_TTL_MS } from '../../core/services/export/export-service';
import type { McpConfirmSummary } from './native-confirm';

/**
 * Jednorazowe znaczniki potwierdzenia serwerow MCP (ADR 0061), ten sam wzorzec co zgoda w ADR 0060.
 * `export:plan` wydaje znacznik dla planu, ktory zapisze serwer MCP, i wysyla go z podgladem serwerow.
 * `export:apply` zuzywa go przy kazdej probie: bez znacznika z podgladu albo z innym serwis odmawia zapisu,
 * wiec renderer nie zapisze serwera MCP jednym wywolaniem bez odczytu planu. Przy znaczniku main
 * trzyma liste serwerow z planu: z niej, a nie z ladunku renderera, powstaje natywne okno (ADR 0063).
 */

const MAX_PENDING = 8;

interface Pending {
  readonly token: string;
  readonly expiresAt: number;
  readonly summary: McpConfirmSummary;
}

export class McpConfirmations {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PLAN_TTL_MS,
  ) {}

  issue(planId: string, summary: McpConfirmSummary): string {
    const nowMs = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt < nowMs) this.pending.delete(id);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const token = randomBytes(24).toString('hex');
    this.pending.set(planId, { token, expiresAt: nowMs + this.ttlMs, summary });
    return token;
  }

  /** Zuzywa znacznik planu; serwery z planu tylko dla waznego znacznika tego planu, inaczej `null`. */
  take(planId: string, given: string | undefined): McpConfirmSummary | null {
    const pending = this.pending.get(planId);
    this.pending.delete(planId);
    if (pending === undefined || given === undefined) return null;
    if (this.now() > pending.expiresAt) return null;
    const a = Buffer.from(pending.token);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b) ? pending.summary : null;
  }
}
