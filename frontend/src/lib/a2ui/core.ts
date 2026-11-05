/** The clawbits chat kit for A2UI v1.0: a surface's flat component list as a typed tree, its values read against the
 *  local data model, the writes its inputs make there, the checks a form runs, and the request a click sends. Pure
 *  TypeScript with no imports, copied byte-identical into apps/mobile. */

export const CATALOG_ID = "https://clawbits.ai/a2ui/chat/v1";

const TONES = ["ok", "info", "warn", "bad", "idle"] as const;
const JUSTIFY = ["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"] as const;
const ALIGN = ["start", "center", "end", "stretch"] as const;
const CHECKS = ["required", "length", "email"] as const;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#]\S*)?$/;
const INDEX = /^(?:0|[1-9]\d*)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:\d{2})?$/;
const INVALID = new Error("invalid surface");

export type Tone = (typeof TONES)[number];
export type Model = Record<string, unknown>;

/** A JSON Pointer into the data model. */
export interface Binding {
  "@path": string;
}

/** A check function. `openUrl` is never a value: it is only ever a link Button's action. */
export interface Call {
  "@call": (typeof CHECKS)[number];
  args: Record<string, unknown>;
}

export type Dynamic<T> = T | Binding | Call;

export interface Check {
  condition: Binding | Call;
  message?: string;
}

/** A link opens an absolute https url on click; an event goes to the agent. */
export type Action =
  | { kind: "link"; url: string }
  | { kind: "event"; name: string; context: Record<string, unknown>; userMessage?: Dynamic<string> };

interface ChartBase {
  component: "Chart";
  id: string;
  title: string;
  xLabel?: string;
  yLabel?: string;
}

export interface PieChart extends ChartBase {
  chartType: "pie";
  segments: { label: string; value: number }[];
}

/** Every series holds one value per category. */
export interface SeriesChart extends ChartBase {
  chartType: "bar" | "line" | "area";
  categories: string[];
  series: { name: string; values: number[] }[];
}

export type UiNode =
  | { component: "Text"; id: string; text: Dynamic<string>; variant: "caption" | "body" }
  | {
      component: "Column" | "Row";
      id: string;
      children: UiNode[];
      justify: (typeof JUSTIFY)[number];
      align: (typeof ALIGN)[number];
    }
  | { component: "Card"; id: string; child: UiNode }
  | { component: "Divider"; id: string }
  | {
      component: "Button";
      id: string;
      child: Extract<UiNode, { component: "Text" }>;
      variant: "default" | "primary" | "borderless";
      action: Action;
      checks: Check[];
    }
  | {
      component: "TextField";
      id: string;
      label: Dynamic<string>;
      value: Dynamic<string>;
      variant: "shortText" | "longText" | "number";
      checks: Check[];
    }
  | {
      component: "ChoicePicker";
      id: string;
      label?: Dynamic<string>;
      options: { label: Dynamic<string>; value: string }[];
      value: Dynamic<string[]>;
      variant: "mutuallyExclusive" | "multipleSelection";
    }
  | { component: "CheckBox"; id: string; label: Dynamic<string>; value: Dynamic<boolean> }
  | {
      component: "DateTimeInput";
      id: string;
      label: Dynamic<string>;
      value: Dynamic<string>;
      enableDate: boolean;
      enableTime: boolean;
    }
  | { component: "Notice"; id: string; tone: Tone; title?: string; text: string }
  | { component: "KeyValue"; id: string; items: { label: string; value: string }[] }
  | {
      component: "Stats";
      id: string;
      items: { label: string; value: string; unit?: string; delta?: string; trend?: "up" | "down" | "flat" }[];
    }
  | { component: "StatusList"; id: string; items: { title: string; subtitle?: string; tone: Tone }[] }
  | {
      component: "Table";
      id: string;
      caption: string;
      headers: string[];
      rows: (string | number)[][];
      rowHeaderColumnIndex?: number;
    }
  | PieChart
  | SeriesChart;

export type UiNodeOf<C extends UiNode["component"]> = Extract<UiNode, { component: C }>;

type Raw = Record<string, unknown>;

function fail(): never {
  throw INVALID;
}

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Raw {
  return isObject(value) ? value : fail();
}

function string(value: unknown): string {
  return typeof value === "string" ? value : fail();
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail();
}

function positive(value: unknown): number {
  const n = number(value);
  return n > 0 ? n : fail();
}

function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail();
}

function cell(value: unknown): string | number {
  return typeof value === "string" ? value : number(value);
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(parse) : fail();
}

function filled<T>(items: T[]): T[] {
  return items.length > 0 ? items : fail();
}

function entry<T>(parse: (fields: Raw) => T): (value: unknown) => T {
  return (value) => parse(object(value));
}

function oneOf<const T extends string>(allowed: readonly T[], value: unknown, fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback;
  return allowed.find((item) => item === value) ?? fail();
}

function bound(value: Raw): Binding | Call {
  if ("@path" in value) return { "@path": string(value["@path"]) };
  return { "@call": oneOf(CHECKS, value["@call"]), args: record(value.args) };
}

/** An object whose values are literals, bindings or calls. */
function record(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([key, item]) => [
      key,
      isObject(item) && ("@path" in item || "@call" in item) ? bound(item) : item,
    ]),
  );
}

function dynamic<T>(literal: (value: unknown) => T): (value: unknown) => Dynamic<T> {
  return (value) => (isObject(value) ? bound(value) : literal(value));
}

const text = dynamic(string);
const flag = dynamic(boolean);
const strings = dynamic((value) => list(value, string));

function action(value: unknown): Action {
  const fields = object(value);
  if (fields.functionCall !== undefined) {
    const call = object(fields.functionCall);
    const url = object(call.args).url;
    return call["@call"] === "openUrl" && typeof url === "string" && HTTPS_URL.test(url) ? { kind: "link", url } : fail();
  }
  const event = object(fields.event);
  return {
    kind: "event",
    name: string(event.name),
    context: event.context === undefined ? {} : record(event.context),
    userMessage: optional(event.userMessage, text),
  };
}

function checks(value: unknown): Check[] {
  return value === undefined
    ? []
    : list(value, entry((c) => ({ condition: bound(object(c.condition)), message: optional(c.message, string) })));
}

function chart(c: Raw, id: string): PieChart | SeriesChart {
  const base = {
    component: "Chart",
    id,
    title: string(c.title),
    xLabel: optional(c.xLabel, string),
    yLabel: optional(c.yLabel, string),
  } as const;
  if (c.chartType === "pie") {
    const segments = list(c.segments, entry((s) => ({ label: string(s.label), value: positive(s.value) })));
    return { ...base, chartType: "pie", segments: filled(segments) };
  }
  const categories = filled(list(c.categories, string));
  const series = filled(list(c.series, entry((s) => ({ name: string(s.name), values: list(s.values, number) }))));
  if (series.some((s) => s.values.length !== categories.length)) fail();
  return { ...base, chartType: oneOf(["bar", "line", "area"], c.chartType), categories, series };
}

function node(c: Raw, id: string, child: (id: unknown) => UiNode): UiNode {
  const name = c.component;
  switch (name) {
    case "Text":
      return { component: name, id, text: text(c.text), variant: oneOf(["caption", "body"], c.variant, "body") };
    case "Column":
    case "Row":
      return {
        component: name,
        id,
        children: list(c.children, child),
        justify: oneOf(JUSTIFY, c.justify, "start"),
        align: oneOf(ALIGN, c.align, "stretch"),
      };
    case "Card":
      return { component: name, id, child: child(c.child) };
    case "Divider":
      return { component: name, id };
    case "Button": {
      const label = child(c.child);
      return {
        component: name,
        id,
        child: label.component === "Text" ? label : fail(),
        variant: oneOf(["default", "primary", "borderless"], c.variant, "default"),
        action: action(c.action),
        checks: checks(c.checks),
      };
    }
    case "TextField":
      return {
        component: name,
        id,
        label: text(c.label),
        value: text(c.value),
        variant: oneOf(["shortText", "longText", "number"], c.variant, "shortText"),
        checks: checks(c.checks),
      };
    case "ChoicePicker":
      return {
        component: name,
        id,
        label: optional(c.label, text),
        options: list(c.options, entry((o) => ({ label: text(o.label), value: string(o.value) }))),
        value: strings(c.value),
        variant: oneOf(["mutuallyExclusive", "multipleSelection"], c.variant, "mutuallyExclusive"),
      };
    case "CheckBox":
      return { component: name, id, label: text(c.label), value: flag(c.value) };
    case "DateTimeInput":
      return {
        component: name,
        id,
        label: text(c.label),
        value: text(c.value),
        enableDate: optional(c.enableDate, boolean) ?? false,
        enableTime: optional(c.enableTime, boolean) ?? false,
      };
    case "Notice":
      return { component: name, id, tone: oneOf(TONES, c.tone), title: optional(c.title, string), text: string(c.text) };
    case "KeyValue":
      return {
        component: name,
        id,
        items: list(c.items, entry((i) => ({ label: string(i.label), value: string(i.value) }))),
      };
    case "Stats":
      return {
        component: name,
        id,
        items: list(c.items, entry((i) => ({
          label: string(i.label),
          value: string(i.value),
          unit: optional(i.unit, string),
          delta: optional(i.delta, string),
          trend: optional(i.trend, (t) => oneOf(["up", "down", "flat"], t)),
        }))),
      };
    case "StatusList":
      return {
        component: name,
        id,
        items: list(c.items, entry((i) => ({
          title: string(i.title),
          subtitle: optional(i.subtitle, string),
          tone: oneOf(TONES, i.tone),
        }))),
      };
    case "Table":
      return {
        component: name,
        id,
        caption: string(c.caption),
        headers: list(c.headers, string),
        rows: list(c.rows, (row) => list(row, cell)),
        rowHeaderColumnIndex: optional(c.rowHeaderColumnIndex, number),
      };
    case "Chart":
      return chart(c, id);
    default:
      return fail();
  }
}

/** The tree under `root`, or null for a surface this kit cannot draw: another catalog, an unknown component, a
 *  missing, duplicate or reused id, or a prop of the wrong shape. The row then shows the post's text instead. */
export function buildTree(surface: { catalogId: string; components: readonly unknown[] }): UiNode | null {
  if (surface.catalogId !== CATALOG_ID) return null;
  const byId = new Map<string, Raw>();
  const used = new Set<string>();
  const child = (id: unknown): UiNode => {
    const key = string(id);
    const component = byId.get(key);
    if (!component || used.has(key)) fail();
    used.add(key);
    return node(component, key, child);
  };
  try {
    for (const item of surface.components) {
      const component = object(item);
      const id = string(component.id);
      if (byId.has(id)) fail();
      byId.set(id, component);
    }
    return child("root");
  } catch (error) {
    if (error === INVALID) return null;
    throw error;
  }
}

function tokens(path: string): string[] {
  return path.split("/").slice(1).map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function pointer(model: Model, path: string): unknown {
  if (path !== "" && !path.startsWith("/")) return undefined;
  return tokens(path).reduce<unknown>((at, key) => {
    if (Array.isArray(at)) return INDEX.test(key) ? (at as unknown[])[Number(key)] : undefined;
    return isObject(at) && Object.hasOwn(at, key) ? at[key] : undefined;
  }, model);
}

function put(at: unknown, keys: string[], value: unknown): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) return value;
  if (Array.isArray(at)) {
    const items: unknown[] = at;
    const i = INDEX.test(key) ? Number(key) : items.length;
    return i < items.length ? items.with(i, put(items[i], rest, value)) : fail();
  }
  const fields: Raw = at === undefined ? {} : object(at);
  return { ...fields, [key]: put(Object.hasOwn(fields, key) ? fields[key] : undefined, rest, value) };
}

/** The JSON Pointer a value is bound to, or undefined for a literal or a call. */
export function pathOf(value: unknown): string | undefined {
  return isObject(value) && typeof value["@path"] === "string" ? value["@path"] : undefined;
}

/** The model with `value` at a JSON Pointer, as an input writes it: a new model, with any missing objects on the way
 *  created. The root, a path that is no pointer, or one through a literal or past an array's end leaves the model as
 *  it is. */
export function write(model: Model, path: string, value: unknown): Model {
  if (!path.startsWith("/")) return model;
  try {
    return put(model, tokens(path), value) as Model;
  } catch (error) {
    if (error === INVALID) return model;
    throw error;
  }
}

/** The `UiActionRequest` a click on an event Button sends, or null for a link. `bound` holds only the context values
 *  bound by `@path`, read from the local model (null where it holds none); the server takes the literals from the
 *  stored surface. */
export function actionRequest(button: UiNodeOf<"Button">, model: Model, rev: number, clientKey: string) {
  if (button.action.kind !== "event") return null;
  const bound = Object.fromEntries(
    Object.entries(button.action.context).flatMap(([key, value]) => {
      const path = pathOf(value);
      return path === undefined ? [] : [[key, pointer(model, path) ?? null] as const];
    }),
  );
  return { rev, sourceComponentId: button.id, bound, client_key: clientKey };
}

/** A value as the data model gives it: a literal as is, a binding by its JSON Pointer. A function call is
 *  undefined: checks run through `checkFailures`, and a link opens only from a click. */
export function resolve(value: unknown, model: Model): unknown {
  if (!isObject(value)) return value;
  if (typeof value["@path"] === "string") return pointer(model, value["@path"]);
  if (typeof value["@call"] === "string") return undefined;
  return value;
}

export function resolveText(value: Dynamic<string>, model: Model): string {
  const resolved = resolve(value, model);
  return typeof resolved === "string" ? resolved : "";
}

export function resolveBoolean(value: Dynamic<boolean>, model: Model): boolean {
  return resolve(value, model) === true;
}

export function resolveStrings(value: Dynamic<string[]>, model: Model): string[] {
  const resolved = resolve(value, model);
  return Array.isArray(resolved) ? resolved.filter((item: unknown): item is string => typeof item === "string") : [];
}

/** The text of each check that fails against the model, in order: its `message` unless empty, else its condition's
 *  default. The server runs the same checks on every click. */
export function checkFailures(checks: readonly Check[], model: Model): string[] {
  return checks.flatMap(({ condition, message }) => {
    const failure = conditionFailure(condition, model);
    return failure === null ? [] : [message || failure];
  });
}

/** A `@path` passes when the value there is `true`. `required` fails on a missing value, a blank string or an empty
 *  list; `length` counts code points, a missing value as ""; `email` passes "", so it pairs with `required`. */
function conditionFailure(condition: Binding | Call, model: Model): string | null {
  if ("@path" in condition) return pointer(model, condition["@path"]) === true ? null : "Check this field.";
  const value = resolve(condition.args.value, model);
  const text = typeof value === "string" ? value : "";
  switch (condition["@call"]) {
    case "required":
      return empty(value) ? "Required." : null;
    case "length": {
      const { min, max } = condition.args;
      const count = Array.from(text).length;
      if (typeof min === "number" && count < min) return `Use at least ${min} characters.`;
      return typeof max === "number" && count > max ? `Use at most ${max} characters.` : null;
    }
    case "email":
      return text === "" || EMAIL.test(text) ? null : "Enter an email address.";
  }
}

function empty(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "";
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The local date and time of `at` to the minute, as a `datetime-local` value. */
function wallClock(at: Date): string {
  return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A `datetime-local` value as a DateTimeInput stores it: the moment the browser reads it as, with the user's UTC
 *  offset then, so the agent gets the moment the user meant and the input shows it back unchanged, a time a clock
 *  change skips included. Anything else is "". */
export function zonedDateTime(local: string): string {
  const at = new Date(local);
  if (!LOCAL_DATE_TIME.test(local) || Number.isNaN(at.getTime())) return "";
  const offset = -at.getTimezoneOffset();
  const minutes = Math.abs(offset);
  return `${wallClock(at)}${local.slice(16)}${offset < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** A stored date and time as a `datetime-local` input shows it: one with an offset or `Z` in the user's local time,
 *  one without as is. Anything else is "". */
export function localDateTime(stored: string): string {
  const match = DATE_TIME.exec(stored);
  const at = new Date(stored);
  if (!match || Number.isNaN(at.getTime())) return "";
  return match[1] === undefined ? stored : wallClock(at);
}
