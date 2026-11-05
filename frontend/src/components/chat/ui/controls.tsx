import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { Checkbox } from "@base-ui/react/checkbox";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { ArrowUpRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  checkFailures,
  localDateTime,
  resolveBoolean,
  resolveStrings,
  resolveText,
  zonedDateTime,
  type Model,
  type UiNodeOf,
} from "@/lib/a2ui/core";
import { openExternal } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const VARIANT = {
  default: "outline",
  primary: "default",
  borderless: "ghost",
} as const satisfies Record<UiNodeOf<"Button">["variant"], "outline" | "default" | "ghost">;

/** A link opens its url on a real click only. An event button sends its action; while it is out, the button keeps
 *  its focus and full strength and shows a spinner. A blocked button, one whose checks fail, stays focusable and
 *  dimmed, and a press goes to `onAction`, link or not, so the card can say why. */
export function SurfaceButton({ node, disabled, blocked, pending, onAction, children }: {
  node: UiNodeOf<"Button">;
  disabled: boolean;
  blocked: boolean;
  pending: boolean;
  onAction: () => void;
  children: ReactNode;
}) {
  const url = node.action.kind === "link" ? node.action.url : null;
  return (
    <Button
      size="sm"
      variant={VARIANT[node.variant]}
      disabled={disabled}
      focusableWhenDisabled={pending}
      aria-disabled={blocked || pending || undefined}
      aria-busy={pending || undefined}
      onClick={(e) => {
        if (!url || blocked) onAction();
        else if (navigator.userActivation?.isActive ?? e.nativeEvent.isTrusted) void openExternal(url);
      }}
      className={cn("max-w-full", blocked && "opacity-50")}
    >
      <span className="truncate">{children}</span>
      {url && <Icon icon={ArrowUpRight01Icon} data-icon="inline-end" className="size-3.5" />}
      {pending && (
        <span
          aria-hidden
          data-icon="inline-end"
          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current/20 border-t-current"
        />
      )}
    </Button>
  );
}

/** Live with `onChange`, read-only without it. Its first failing check shows under it once touched: blurred after an
 *  edit, or once a Button on the card was `pressed`. */
export function TextField({ node, model, disabled, pressed, onChange }: {
  node: UiNodeOf<"TextField">;
  model: Model;
  disabled: boolean;
  pressed: boolean;
  onChange?: (value: string) => void;
}) {
  const id = useId();
  const [edit, setEdit] = useState<"pristine" | "edited" | "touched">("pristine");
  const failure = pressed || edit === "touched" ? checkFailures(node.checks, model)[0] : undefined;
  const field = {
    id,
    value: resolveText(node.value, model),
    maxLength: 2000,
    readOnly: !onChange,
    disabled,
    "aria-invalid": failure !== undefined || undefined,
    "aria-describedby": failure === undefined ? undefined : `${id}-check`,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange?.(e.target.value);
      if (edit === "pristine") setEdit("edited");
    },
    onBlur: () => { if (edit === "edited") setEdit("touched"); },
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{resolveText(node.label, model)}</Label>
      {node.variant === "longText" ? (
        <textarea
          {...field}
          rows={3}
          className="w-full min-w-0 resize-none rounded-md border border-transparent bg-input/50 px-3 py-2 text-base transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
        />
      ) : (
        <Input {...field} type={node.variant === "number" ? "number" : "text"} />
      )}
      {failure !== undefined && <p id={`${id}-check`} className="text-[13px] text-destructive">{failure}</p>}
    </div>
  );
}

/** Live only with `onChange`, which gets the picked option values; without it the picks only show. */
export function ChoicePicker({ node, model, onChange }: {
  node: UiNodeOf<"ChoicePicker">;
  model: Model;
  onChange?: (values: string[]) => void;
}) {
  const id = useId();
  const label = node.label && resolveText(node.label, model);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label && <span id={id} className="text-sm leading-none font-medium">{label}</span>}
      <ToggleGroup
        value={resolveStrings(node.value, model)}
        onValueChange={onChange}
        multiple={node.variant === "multipleSelection"}
        disabled={!onChange}
        aria-labelledby={label ? id : undefined}
        className="flex flex-wrap gap-1.5"
      >
        {node.options.map((option, i) => (
          <Toggle
            key={i}
            value={option.value}
            className="h-8 rounded-full border border-border px-3 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 data-disabled:pointer-events-none data-disabled:opacity-50 data-pressed:border-transparent data-pressed:bg-foreground/8 data-pressed:text-foreground"
          >
            {resolveText(option.label, model)}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Live with `onChange`, read-only without it. */
export function CheckBox({ node, model, disabled, onChange }: {
  node: UiNodeOf<"CheckBox">;
  model: Model;
  disabled: boolean;
  onChange?: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <Checkbox.Root
        checked={resolveBoolean(node.value, model)}
        onCheckedChange={onChange}
        readOnly={!onChange}
        disabled={disabled}
        className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 data-disabled:opacity-50 data-checked:border-transparent data-checked:bg-foreground data-checked:text-background"
      >
        <Checkbox.Indicator>
          <Icon icon={Tick02Icon} className="size-3" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      {resolveText(node.label, model)}
    </label>
  );
}

/** Live with `onChange`, read-only without it. A date and time shows in local time and is written with the user's
 *  UTC offset. */
export function DateTimeInput({ node, model, disabled, onChange }: {
  node: UiNodeOf<"DateTimeInput">;
  model: Model;
  disabled: boolean;
  onChange?: (value: string) => void;
}) {
  const id = useId();
  const zoned = node.enableDate && node.enableTime;
  const value = resolveText(node.value, model);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{resolveText(node.label, model)}</Label>
      <Input
        id={id}
        type={zoned ? "datetime-local" : node.enableTime ? "time" : "date"}
        value={zoned ? localDateTime(value) : value}
        readOnly={!onChange}
        disabled={disabled}
        onChange={(e) => { onChange?.(zoned ? zonedDateTime(e.target.value) : e.target.value); }}
      />
    </div>
  );
}
