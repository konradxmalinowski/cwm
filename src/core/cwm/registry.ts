import type { ResourceRef } from './kinds';
import type { Resource } from './resource';

/**
 * Zrodlo zasobow dla resolvera. Port jest synchroniczny: implementacja oparta na bibliotece
 * wczytuje zasoby przed wywolaniem `resolve`, zeby rdzen zostal czysty.
 * `candidates` zwraca wszystkie definicje pod danym id: 0 to brak, 1 to poprawny wynik,
 * wiecej to konflikt identyfikatorow, ktory resolver zglasza jako blad.
 */
export interface ResourceRegistry {
  candidates(ref: ResourceRef): readonly Resource[];
}
