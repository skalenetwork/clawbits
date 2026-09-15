import { useRef, type ReactNode } from "react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Avatar } from "@/components/Avatar";
import { Icon, type AppIcon } from "@/components/Icon";
import { Scrim } from "@/components/ProgressiveBlur";
import { UserAvatar } from "@/components/UserAvatar";
import type { DirectoryEntry } from "@/components/modals/useOrgDirectory";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CHANNEL_AVATAR_SHAPE } from "@/lib/avatarShapes";
import { cn } from "@/lib/utils";

const KIND_WIDTH = {
  picker: "sm:max-w-[30rem]",
  form: "sm:max-w-[28rem]",
  confirm: "sm:max-w-[24rem]",
};

export function ModalPanel({
  open,
  onOpenChange,
  kind,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: keyof typeof KIND_WIDTH;
  children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={popupRef}
        showCloseButton={false}
        // Keep a field that autofocused itself, else focus the panel: the header's close button would draw a ring.
        initialFocus={() => {
          const popup = popupRef.current;
          const active = document.activeElement;
          return active instanceof HTMLElement && popup?.contains(active) ? active : (popup ?? true);
        }}
        className={cn(
          "gap-0 overflow-hidden border border-border bg-popover p-0 ring-0 backdrop-blur-none backdrop-saturate-100 supports-[backdrop-filter]:bg-popover",
          KIND_WIDTH[kind],
        )}
      >
        <div className="no-scrollbar flex max-h-[min(32rem,80dvh)] flex-col overflow-y-auto overscroll-contain">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ModalHeader({
  title,
  subtitle,
  description,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Screen readers only: visible guidance belongs in the body. */
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10">
      <Scrim color="popover" inset />
      <div className="relative pt-4 pr-12 pb-3 pl-4">
        <DialogTitle className="block truncate text-[15px] leading-6 font-medium">{title}</DialogTitle>
        {subtitle != null && <p className="truncate text-[13px] text-muted-foreground">{subtitle}</p>}
        <DialogClose
          aria-label="Close"
          className="absolute top-3 right-2 grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--sb-hover)] hover:text-foreground"
        >
          <Icon icon={Cancel01Icon} className="size-4" />
        </DialogClose>
      </div>
      {description != null && <DialogDescription className="sr-only">{description}</DialogDescription>}
      {children}
    </div>
  );
}

export function ModalSearch({
  value,
  onChange,
  placeholder,
  autoFocus = true,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Doubles as the accessible label. */
  placeholder: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="mx-1.5 mb-1.5 flex h-[34px] items-center gap-[9px] rounded-[9px] px-2.5 transition-colors duration-100 hover:bg-[var(--field)] focus-within:bg-[var(--field)]">
      <Icon icon={Search01Icon} className="size-[15px] shrink-0 text-muted-foreground" />
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={e => { onChange(e.target.value); }}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground disabled:opacity-60 max-md:text-[16px]"
      />
    </div>
  );
}

export interface ModalTab<T extends string> {
  id: T;
  label: string;
  icon?: AppIcon;
}

/** A radio group, not tabs: no tabpanel follows, the choice filters one list. */
export function ModalTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  disabled,
}: {
  tabs: readonly ModalTab<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={t.id === value}
          onClick={() => { onChange(t.id); }}
          disabled={disabled}
          className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-[var(--sb-active)] aria-checked:text-foreground"
        >
          {t.icon && <Icon icon={t.icon} className="size-3.5" />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

const FIELD_LABEL = "text-[12px] font-medium text-muted-foreground";

/** Omit `htmlFor` where nothing is labelable (a radio group names itself): it renders a heading, not a dangling label. */
export function ModalField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor === undefined ? (
        <span className={FIELD_LABEL}>{label}</span>
      ) : (
        <label htmlFor={htmlFor} className={FIELD_LABEL}>{label}</label>
      )}
      {children}
    </div>
  );
}

/** The tail fade shows only when the list ends the panel (`last:block`); otherwise the footer's scrim owns that edge. */
export function ModalList({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="p-1.5">{children}</div>
      <div aria-hidden className="pointer-events-none sticky bottom-0 z-10 -mt-3 hidden h-3 shrink-0 last:block">
        <Scrim color="popover" side="bottom" inset />
      </div>
    </>
  );
}

export function ModalSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <div className="px-2.5 pt-2.5 pb-1.5 text-[12px] font-medium text-muted-foreground">{label}</div>
      {children}
    </section>
  );
}

export function ModalNote({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-2 text-[13px] text-muted-foreground">{children}</p>;
}

type ModalRowProps = {
  kind: "human" | "agent" | "channel";
  name: string;
  /** Avatar seed when it differs from the name, e.g. a person's id, which survives renames. */
  seed?: string;
  avatarUrl?: string | null;
  note?: ReactNode;
} & (
  | { onSelect: () => void; disabled?: boolean; action?: never }
  | {
      onSelect?: never;
      disabled?: never;
      action?: { label: string; onClick: () => void; destructive?: boolean; disabled?: boolean };
    }
);

const ROW =
  "group/row flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors hover:bg-[var(--sb-hover)] max-md:h-11";

export function ModalRow({ kind, name, seed, avatarUrl, note, onSelect, disabled, action }: ModalRowProps) {
  const avatar = { size: 20, name: seed ?? name, src: avatarUrl, className: "shrink-0" };
  const body = (
    <>
      {kind === "agent" ? (
        <AgentFaceAvatar {...avatar} />
      ) : kind === "channel" ? (
        <Avatar {...avatar} className={cn(CHANNEL_AVATAR_SHAPE, "shrink-0")} />
      ) : (
        <UserAvatar {...avatar} />
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {note != null && <span className="shrink-0 text-[12px] font-normal text-muted-foreground">{note}</span>}
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className={cn(ROW, "outline-none focus-visible:bg-[var(--sb-hover)] disabled:opacity-60")}
      >
        {body}
      </button>
    );
  }

  return (
    <div className={cn(ROW, "has-[:focus-visible]:bg-[var(--sb-hover)]", action && "pr-[5px]")}>
      {body}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          aria-label={`${action.label} ${name}`}
          // Opacity, not conditional rendering: the action stays in the tab order and paints back in on focus.
          className={cn(
            "inline-flex h-6 shrink-0 items-center rounded-[7px] px-[9px] text-[12.5px] text-muted-foreground opacity-0 outline-none transition group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:text-muted-foreground/40 max-md:opacity-100",
            action.destructive
              ? "hover:bg-destructive/10 hover:text-destructive"
              : "hover:bg-[var(--sb-hover)] hover:text-foreground",
          )}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ModalDirectory({
  all,
  sections,
  disabled,
  note,
  onSelect,
}: {
  all: DirectoryEntry[];
  sections: { label: string; entries: DirectoryEntry[] }[];
  disabled: boolean;
  note: (entry: DirectoryEntry) => ReactNode;
  onSelect: (entry: DirectoryEntry) => void;
}) {
  return (
    <ModalList>
      {sections.length === 0 ? (
        <ModalNote>{all.length === 0 ? "No one else in this organization yet." : "No matches"}</ModalNote>
      ) : (
        sections.map(s => (
          <ModalSection key={s.label} label={s.label}>
            {s.entries.map(e => (
              <ModalRow
                key={e.key}
                kind={e.kind}
                name={e.name}
                avatarUrl={e.avatarUrl}
                note={note(e)}
                onSelect={() => { onSelect(e); }}
                disabled={disabled}
              />
            ))}
          </ModalSection>
        ))
      )}
    </ModalList>
  );
}

export function ModalFooter({ left, children }: { left?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 px-4 pt-2 pb-4">
      <Scrim color="popover" side="bottom" inset />
      <div className="-ml-2.5 flex min-w-0 items-center gap-1">{left}</div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

const BUTTON_TONE = {
  quiet: "text-foreground hover:bg-[var(--sb-hover)]",
  primary: "bg-primary text-primary-foreground hover:bg-primary/80",
  destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
};

export function ModalButton({
  onClick,
  tone = "quiet",
  type = "button",
  disabled,
  children,
}: {
  onClick?: () => void;
  tone?: keyof typeof BUTTON_TONE;
  type?: "button" | "submit";
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "shrink-0 rounded-md px-2.5 py-1.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        BUTTON_TONE[tone],
      )}
    >
      {children}
    </button>
  );
}
