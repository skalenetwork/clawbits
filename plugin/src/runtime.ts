import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type PluginRuntime = OpenClawPluginApi["runtime"];

export interface KeyedStore<T> {
  lookup(key: string): Promise<T | undefined>;
  register(key: string, value: T): Promise<void>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
}

let current: PluginRuntime | undefined;

export function setRuntime(next: PluginRuntime): void {
  current = next;
}

export function pluginRuntime(): PluginRuntime | undefined {
  return current;
}
