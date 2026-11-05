import { afterEach, describe, expect, it, vi } from "vitest";

import {
  actionRequest,
  buildTree,
  CATALOG_ID,
  checkFailures,
  localDateTime,
  pathOf,
  resolve,
  resolveBoolean,
  resolveStrings,
  resolveText,
  write,
  zonedDateTime,
  type Call,
  type Check,
  type UiNodeOf,
} from "./core";

const surface = (...components: Record<string, unknown>[]) => ({ catalogId: CATALOG_ID, components });
const text = (id: string, value: unknown = "Hi") => ({ id, component: "Text", text: value });
const link = (url: unknown) => ({ functionCall: { "@call": "openUrl", args: { url } } });

describe("buildTree", () => {
  it("builds the typed tree under root, with the catalog's defaults", () => {
    const tree = buildTree(surface(
      { id: "root", component: "Card", child: "body" },
      { id: "body", component: "Column", children: ["title", "runs"] },
      text("title", "**Deploys**"),
      { id: "runs", component: "StatusList", items: [{ title: "api v2.4.1", tone: "ok" }] },
    ));
    expect(tree).toEqual({
      component: "Card",
      id: "root",
      child: {
        component: "Column",
        id: "body",
        justify: "start",
        align: "stretch",
        children: [
          { component: "Text", id: "title", text: "**Deploys**", variant: "body" },
          { component: "StatusList", id: "runs", items: [{ title: "api v2.4.1", subtitle: undefined, tone: "ok" }] },
        ],
      },
    });
  });

  it("keeps bindings and check calls as written", () => {
    const tree = buildTree(surface({
      id: "root",
      component: "TextField",
      label: "Email",
      value: { "@path": "/form/email" },
      checks: [{ condition: { "@call": "email", args: { value: { "@path": "/form/email" } } }, message: "Not an email" }],
    }));
    expect(tree).toMatchObject({
      value: { "@path": "/form/email" },
      variant: "shortText",
      checks: [{ condition: { "@call": "email", args: { value: { "@path": "/form/email" } } }, message: "Not an email" }],
    });
  });

  it("reads a Button's action as a link or an event", () => {
    const open = buildTree(surface({ id: "root", component: "Button", child: "t", action: link("https://clawbits.ai/x") }, text("t")));
    expect(open).toMatchObject({ variant: "default", action: { kind: "link", url: "https://clawbits.ai/x" }, checks: [] });
    const event = buildTree(surface(
      { id: "root", component: "Button", child: "t", action: { event: { name: "pick", context: { env: "staging", who: { "@path": "/me" } } } } },
      text("t"),
    ));
    expect(event).toMatchObject({ action: { kind: "event", name: "pick", context: { env: "staging", who: { "@path": "/me" } } } });
  });

  it("checks a chart's shape", () => {
    const chart = (props: Record<string, unknown>) => buildTree(surface({ id: "root", component: "Chart", title: "Runs", ...props }));
    expect(chart({ chartType: "bar", categories: ["a", "b"], series: [{ name: "ok", values: [1, 2] }] })).toMatchObject({
      chartType: "bar",
      categories: ["a", "b"],
    });
    expect(chart({ chartType: "pie", segments: [{ label: "a", value: 3 }] })).toMatchObject({ chartType: "pie" });
    expect(chart({ chartType: "line", categories: ["a", "b"], series: [{ name: "ok", values: [1] }] })).toBeNull();
    expect(chart({ chartType: "pie", segments: [{ label: "a", value: 0 }] })).toBeNull();
    expect(chart({ chartType: "pie", segments: [] })).toBeNull();
    expect(chart({ chartType: "bar", segments: [{ label: "a", value: 3 }] })).toBeNull();
  });

  it.each([
    ["another catalog", { catalogId: "https://a2ui.org/basic", components: [text("root")] }],
    ["no root", surface(text("intro"))],
    ["a dangling child", surface({ id: "root", component: "Card", child: "missing" })],
    ["a duplicate id", surface(text("root"), text("root"))],
    ["a cycle", surface({ id: "root", component: "Card", child: "root" })],
    ["a child used twice", surface({ id: "root", component: "Row", children: ["t", "t"] }, text("t"))],
    ["a template child list", surface({ id: "root", component: "Column", children: { componentId: "t", path: "/items" } }, text("t"))],
    ["an unknown component", surface({ id: "root", component: "Image", url: "https://x" })],
    ["a wrong prop type", surface(text("root", 3))],
    ["an unknown enum value", surface({ id: "root", component: "Notice", tone: "danger", text: "x" })],
    ["a missing required prop", surface({ id: "root", component: "KeyValue" })],
    ["a non-https link", surface({ id: "root", component: "Button", child: "t", action: link("http://x.com") }, text("t"))],
    ["a link with credentials", surface({ id: "root", component: "Button", child: "t", action: link("https://a@b.com") }, text("t"))],
    ["a script link", surface({ id: "root", component: "Button", child: "t", action: link("javascript:alert(1)") }, text("t"))],
    ["a bound link", surface({ id: "root", component: "Button", child: "t", action: link({ "@path": "/url" }) }, text("t"))],
    ["a function outside the kit", surface(text("root", { "@call": "formatDate", args: { value: "x" } }))],
    ["a secret field", surface({ id: "root", component: "TextField", label: "Key", value: "", variant: "obscured" })],
    ["a literal check", surface({ id: "root", component: "TextField", label: "Name", value: "", checks: [{ condition: true }] })],
    ["openUrl as a value", surface(text("root", { "@call": "openUrl", args: { url: "https://x.com" } }))],
    ["a Button labelled by another Button", surface(
      { id: "root", component: "Button", child: "inner", action: link("https://x.com") },
      { id: "inner", component: "Button", child: "t", action: link("https://x.com") },
      text("t"),
    )],
  ])("returns null for %s", (_, input) => {
    expect(buildTree(input)).toBeNull();
  });
});

describe("resolve", () => {
  const model = { user: { name: "Ada", "a/b": 1, "m~n": 2 }, tags: ["x", "y"], empty: "" };

  it("passes literals through and reads bindings by JSON Pointer", () => {
    expect(resolve("plain", model)).toBe("plain");
    expect(resolve({ "@path": "/user/name" }, model)).toBe("Ada");
    expect(resolve({ "@path": "/user/a~1b" }, model)).toBe(1);
    expect(resolve({ "@path": "/user/m~0n" }, model)).toBe(2);
    expect(resolve({ "@path": "/tags/1" }, model)).toBe("y");
    expect(resolve({ "@path": "" }, model)).toBe(model);
  });

  it("reads nothing outside the model", () => {
    expect(resolve({ "@path": "/user/missing" }, model)).toBeUndefined();
    expect(resolve({ "@path": "/tags/01" }, model)).toBeUndefined();
    expect(resolve({ "@path": "/user/constructor" }, model)).toBeUndefined();
    expect(resolve({ "@path": "user/name" }, model)).toBeUndefined();
  });

  it("reads no function call as a value", () => {
    expect(resolve({ "@call": "required", args: { value: { "@path": "/user/name" } } }, model)).toBeUndefined();
    expect(resolve({ "@call": "openUrl", args: { url: "https://x.com" } }, model)).toBeUndefined();
  });

  it("resolves typed values, with an empty value for the wrong type", () => {
    expect(resolveText({ "@path": "/user/name" }, model)).toBe("Ada");
    expect(resolveText({ "@path": "/user/a~1b" }, model)).toBe("");
    expect(resolveStrings({ "@path": "/tags" }, model)).toEqual(["x", "y"]);
    expect(resolveStrings({ "@path": "/user" }, model)).toEqual([]);
    expect(resolveBoolean(true, model)).toBe(true);
    expect(resolveBoolean({ "@path": "/user/name" }, model)).toBe(false);
  });
});

describe("write", () => {
  const model = { form: { env: ["staging"] }, steps: [{ ok: false }], label: "x" };

  it("writes a new model by JSON Pointer and leaves the old one as it was", () => {
    const next = write(model, "/form/env", ["production"]);
    expect(next).toEqual({ ...model, form: { env: ["production"] } });
    expect(next.steps).toBe(model.steps);
    expect(model.form.env).toEqual(["staging"]);
    expect(write(model, "/steps/0/ok", true)).toEqual({ ...model, steps: [{ ok: true }] });
    expect(write({}, "/a~1b/m~0n", 1)).toEqual({ "a/b": { "m~n": 1 } });
  });

  it("creates the objects a pointer needs", () => {
    expect(write({}, "/pick", [])).toEqual({ pick: [] });
    expect(write({ form: {} }, "/form/deep/pick", ["a"])).toEqual({ form: { deep: { pick: ["a"] } } });
  });

  it("keeps a key named like a prototype field as the model's own", () => {
    const next = write({}, "/__proto__", ["a"]);
    expect(Object.hasOwn(next, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
  });

  it.each([
    ["the root", ""],
    ["no pointer", "form/env"],
    ["through a literal", "/label/env"],
    ["past an array's end", "/steps/1/ok"],
    ["a non-index into an array", "/steps/first"],
  ])("leaves the model as it is for %s", (_, path) => {
    expect(write(model, path, ["a"])).toBe(model);
  });
});

describe("actionRequest", () => {
  const button = (action: unknown) =>
    buildTree(surface({ id: "root", component: "Button", child: "t", action }, text("t"))) as UiNodeOf<"Button">;

  it("sends only the bound context values, read from the local model", () => {
    const deploy = button({
      event: { name: "deploy", context: { target: { "@path": "/target" }, env: "staging", unset: { "@path": "/none" } } },
    });
    expect(actionRequest(deploy, { target: ["production"] }, 3, "key-1")).toEqual({
      rev: 3,
      sourceComponentId: "root",
      bound: { target: ["production"], unset: null },
      client_key: "key-1",
    });
  });

  it("sends each input kind's bound value as the model holds it", () => {
    const form = buildTree(surface(
      { id: "root", component: "Column", children: ["name", "agree", "when", "env", "send"] },
      { id: "name", component: "TextField", label: "Name", value: { "@path": "/form/name" } },
      { id: "agree", component: "CheckBox", label: "Agree", value: { "@path": "/form/agree" } },
      { id: "when", component: "DateTimeInput", label: "When", value: { "@path": "/form/when" }, enableDate: true, enableTime: true },
      { id: "env", component: "ChoicePicker", options: [{ label: "Staging", value: "staging" }], value: { "@path": "/form/env" } },
      {
        id: "send",
        component: "Button",
        child: "t",
        action: {
          event: {
            name: "send",
            context: {
              name: { "@path": "/form/name" },
              agree: { "@path": "/form/agree" },
              when: { "@path": "/form/when" },
              env: { "@path": "/form/env" },
            },
          },
        },
      },
      text("t"),
    )) as UiNodeOf<"Column" | "Row">;
    const send = form.children[4] as UiNodeOf<"Button">;
    const model = { form: { name: "Ada", agree: false, when: "2026-11-05T09:30+01:00", env: ["staging"] } };
    expect(actionRequest(send, model, 1, "k")?.bound).toEqual(model.form);
    expect(actionRequest(send, {}, 1, "k")?.bound).toEqual({ name: null, agree: null, when: null, env: null });
  });

  it("sends an empty bound for an event with literals only, and nothing for a link", () => {
    expect(actionRequest(button({ event: { name: "ok", context: { a: 1 } } }), { a: 2 }, 0, "k")?.bound).toEqual({});
    expect(actionRequest(button(link("https://clawbits.ai")), {}, 0, "k")).toBeNull();
  });
});

describe("checkFailures", () => {
  const call = (name: Call["@call"], args: Record<string, unknown>, message?: string): Check =>
    ({ condition: { "@call": name, args }, message });
  const fails = (check: Check, model: Record<string, unknown> = {}) => checkFailures([check], model);

  it("passes a path only where the model holds true", () => {
    const agreed: Check = { condition: { "@path": "/agree" } };
    expect(fails(agreed, { agree: true })).toEqual([]);
    expect(fails(agreed, { agree: "true" })).toEqual(["Check this field."]);
    expect(fails(agreed)).toEqual(["Check this field."]);
    expect(fails({ ...agreed, message: "Accept the terms." })).toEqual(["Accept the terms."]);
    expect(fails({ ...agreed, message: "" })).toEqual(["Check this field."]);
  });

  it.each([undefined, null, "", "  \n", []])("requires a value, failing %j", (value) => {
    expect(fails(call("required", { value: { "@path": "/v" } }), { v: value })).toEqual(["Required."]);
  });

  it.each([false, 0, "a", ["a"], {}])("requires a value, passing %j", (value) => {
    expect(fails(call("required", { value: { "@path": "/v" } }), { v: value })).toEqual([]);
  });

  it("counts length in code points, a missing value as empty", () => {
    const length = (min?: number, max?: number) => call("length", { value: { "@path": "/v" }, min, max });
    expect(fails(length(2, 2), { v: "😀😀" })).toEqual([]);
    expect(fails(length(3), { v: "😀😀" })).toEqual(["Use at least 3 characters."]);
    expect(fails(length(undefined, 1), { v: "😀😀" })).toEqual(["Use at most 1 characters."]);
    expect(fails(length(1))).toEqual(["Use at least 1 characters."]);
    expect(fails(length(undefined, 0))).toEqual([]);
  });

  it.each([["", true], ["ada@clawbits.ai", true], ["ada@clawbits", false], ["ada lovelace@x.io", false], ["@x.io", false]])(
    "checks an email address: %j passes %s",
    (value, passes) => {
      expect(fails(call("email", { value: { "@path": "/v" } }), { v: value })).toEqual(passes ? [] : ["Enter an email address."]);
    },
  );

  it("reads literal arguments and keeps every failure in order, with its own message", () => {
    const checks = [
      call("required", { value: "" }),
      call("email", { value: "x" }, "Not an email."),
      call("length", { value: "ok", min: 1 }),
    ];
    expect(checkFailures(checks, {})).toEqual(["Required.", "Not an email."]);
  });
});

describe("date-time helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["Europe/Berlin", "2026-01-15T09:30", "2026-01-15T09:30+01:00"],
    ["Europe/Berlin", "2026-07-15T09:30:05", "2026-07-15T09:30:05+02:00"],
    ["America/New_York", "2026-07-15T09:30", "2026-07-15T09:30-04:00"],
    ["Asia/Kolkata", "2026-01-15T09:30", "2026-01-15T09:30+05:30"],
    ["UTC", "2026-01-15T09:30", "2026-01-15T09:30+00:00"],
  ])("writes a datetime-local value in %s with that date's offset", (zone, local, stored) => {
    vi.stubEnv("TZ", zone);
    expect(zonedDateTime(local)).toBe(stored);
    expect(localDateTime(stored)).toBe(local.slice(0, 16));
  });

  it("writes a time a clock change skips as the browser reads it, and a year below 1000 in four digits", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    expect(zonedDateTime("2026-03-29T02:30")).toBe("2026-03-29T03:30+02:00");
    expect(localDateTime(zonedDateTime("0002-11-04T18:30"))).toBe("0002-11-04T18:30");
  });

  it.each(["", "2026-01-15", "09:30", "2026-01-15T09:30Z", "2026-01-15 09:30", "soon"])("writes %j as empty", (local) => {
    expect(zonedDateTime(local)).toBe("");
  });

  it("shows a stored value in local time, and one without an offset as is", () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    expect(localDateTime("2026-01-15T08:30Z")).toBe("2026-01-15T09:30");
    expect(localDateTime("2026-01-15T23:30-05:00")).toBe("2026-01-16T05:30");
    expect(localDateTime("2026-01-15T09:30")).toBe("2026-01-15T09:30");
    expect(localDateTime("2026-01-15T09:30:15")).toBe("2026-01-15T09:30:15");
  });

  it.each(["", "2026-01-15", "09:30", "2026-01-15T09:30+0100", "tomorrow"])("shows %j as empty", (stored) => {
    expect(localDateTime(stored)).toBe("");
  });
});

describe("pathOf", () => {
  it("names a binding's pointer and nothing else", () => {
    expect(pathOf({ "@path": "/target" })).toBe("/target");
    expect(pathOf(["a"])).toBeUndefined();
    expect(pathOf({ "@call": "required", args: {} })).toBeUndefined();
  });
});
