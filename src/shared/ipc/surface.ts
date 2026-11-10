import { IPC_CHANNELS, type IpcChannel } from './channels';

export type InvokeFn = (channel: IpcChannel, payload?: unknown) => Promise<unknown>;

type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

type NamespaceOf<C extends string> = C extends `${infer N}:${string}` ? N : never;
type MemberOf<C extends string, N extends string> = C extends `${N}:${infer M}`
  ? CamelCase<M>
  : never;

export type BridgeSurface = {
  readonly [N in NamespaceOf<IpcChannel>]: {
    readonly [M in MemberOf<IpcChannel, N>]: (payload?: unknown) => Promise<unknown>;
  };
};

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Buduje most rendererowy wylacznie z zamknietej listy kanalow. Nie ma tu
 * funkcji przyjmujacej dowolna nazwe kanalu, wiec renderer nie moze wywolac
 * niczego, czego nie ma w `IPC_CHANNELS`. Wynik jest zamrozony na obu
 * poziomach, zeby skompromitowany renderer nie dopisal sobie metody.
 */
export function buildBridgeSurface(invoke: InvokeFn): BridgeSurface {
  const namespaces = new Map<string, Record<string, unknown>>();

  for (const channel of IPC_CHANNELS) {
    const separator = channel.indexOf(':');
    const namespace = channel.slice(0, separator);
    const member = toCamelCase(channel.slice(separator + 1));

    let target = namespaces.get(namespace);
    if (target === undefined) {
      target = {};
      namespaces.set(namespace, target);
    }
    target[member] = (payload?: unknown): Promise<unknown> => invoke(channel, payload);
  }

  const surface: Record<string, unknown> = {};
  for (const [namespace, members] of namespaces) {
    surface[namespace] = Object.freeze(members);
  }

  return Object.freeze(surface) as BridgeSurface;
}

/** Plaska lista kluczy mostu, uzywana przez testy do porownania z lista kanalow. */
export function bridgeSurfaceKeys(surface: BridgeSurface): string[] {
  const keys: string[] = [];
  for (const namespace of Object.keys(surface)) {
    const value = (surface as Record<string, unknown>)[namespace];
    if (typeof value !== 'object' || value === null) continue;
    for (const member of Object.keys(value)) {
      keys.push(`${namespace}.${member}`);
    }
  }
  return keys.sort();
}
