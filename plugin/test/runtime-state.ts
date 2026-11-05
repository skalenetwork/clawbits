import type { KeyedStore, PluginRuntime } from "../src/runtime.js";

export function memoryStore<T>(): KeyedStore<T> & { rows: Map<string, T> } {
  const rows = new Map<string, T>();
  return {
    rows,
    lookup: async (key) => rows.get(key),
    register: async (key, value) => {
      rows.set(key, value);
    },
    consume: async (key) => {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    delete: async (key) => rows.delete(key),
  };
}

export function memoryState(): PluginRuntime["state"] {
  const stores = new Map<string, KeyedStore<unknown>>();
  return {
    openKeyedStore: ({ namespace }: { namespace: string }) => {
      const store = stores.get(namespace) ?? memoryStore();
      stores.set(namespace, store);
      return store;
    },
    openChannelIngressQueue: () => ({}),
  } as unknown as PluginRuntime["state"];
}
