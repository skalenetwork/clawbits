/**
 * The env list rows. A port of clawbits'
 * `frontend/src/components/agent/manage/EnvSection.tsx`, kept visually and
 * behaviourally identical: reef builds without a clawbits checkout, so the two
 * cannot share a component. The LOGIC they both run does live in one place per
 * repo (`lib/envApply.ts` here, `components/reef/envKeys.ts` there) and clawbits'
 * `envApplyParity.test.ts` compiles both copies and fails on any disagreement.
 *
 * Reading and editing are distinct modes: a click in the row does nothing, and
 * editing starts only from the row menu. Every cell is the same height in both
 * modes, so the list never jumps under the cursor.
 */
import { useState } from "react"
import {
  Copy01Icon,
  Delete02Icon,
  LockIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  SquareUnlock02Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons"
import { effectiveTier, type EnvDraftRow, type EnvTier } from "@/lib/envApply"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/Icon"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Every cell is this tall, in both states. */
const CELL = "flex h-9 min-w-0 items-center"

/** The value box for a value being ENTERED. Visible by default: masking your own
 *  keystrokes buys nothing (you typed it, and it is not stored yet) while making
 *  a long key impossible to proofread. The eye is for when someone is watching. */
function ValueField({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (v: string) => void
}) {
  const [hidden, setHidden] = useState(false)
  return (
    <div className="relative min-w-0 flex-1">
      <Input
        type={hidden ? "password" : "text"}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
        placeholder="value"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="h-9 pr-9 font-mono text-sm"
      />
      <button
        type="button"
        onClick={() => {
          setHidden((h) => !h)
        }}
        disabled={disabled}
        aria-label={hidden ? "Show value" : "Hide value"}
        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <Icon icon={hidden ? ViewOffSlashIcon : ViewIcon} className="size-3.5" />
      </button>
    </div>
  )
}

/** One quiet lock, shown ONLY while editing. Locked = secret (write-only
 *  forever), unlocked = regular (readable later). Defaulted by name upstream, so
 *  this is an override, not a required decision. */
function TierToggle({
  tier,
  disabled,
  needsValue,
  onChange,
}: {
  tier: EnvTier
  disabled: boolean
  needsValue: boolean
  onChange: (next: EnvTier) => void
}) {
  const secret = tier === "secret"
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={secret ? "Make this value readable" : "Keep this value hidden"}
      title={
        secret
          ? needsValue
            ? "Hidden. Making it readable needs the value re-entered."
            : "Hidden: never shown again after saving."
          : "Readable: you can see this value later."
      }
      onClick={() => {
        onChange(secret ? "regular" : "secret")
      }}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
        secret ? "text-muted-foreground/70" : "text-muted-foreground/40",
        "hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      <Icon icon={secret ? LockIcon : SquareUnlock02Icon} className="size-3.5" />
    </button>
  )
}

/** Edit and Delete behind one menu, so the row keeps a single trailing control
 *  and neither destructive nor mode-switching actions sit under a stray click. */
function RowMenu({
  label,
  busy,
  editing,
  onEdit,
  onRemove,
}: {
  label: string
  busy: boolean
  editing: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        aria-label={`Actions for ${label}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <Icon icon={MoreHorizontalIcon} className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem disabled={editing} onClick={onEdit}>
          <Icon icon={PencilEdit02Icon} className="size-3.5" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Icon icon={Delete02Icon} className="size-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function EnvRow({
  row,
  canEdit,
  busy,
  editing,
  onEdit,
  onChange,
  onRemove,
  onRestore,
}: {
  row: EnvDraftRow
  canEdit: boolean
  busy: boolean
  editing: boolean
  onEdit: () => void
  onChange: (part: Partial<EnvDraftRow>) => void
  onRemove: () => void
  onRestore: () => void
}) {
  const tier = effectiveTier(row)
  // Only ever non-null for a regular var: reef withholds a secret's value.
  const storedValue = row.storedValue ?? null
  const shown = storedValue !== null && storedValue.length > 0 ? storedValue : null
  const [copied, setCopied] = useState(false)

  if (row.removed) {
    return (
      <div className="flex items-center gap-3 px-4 py-2">
        <span className={cn(CELL, "flex-1")}>
          <span className="truncate font-mono text-sm text-muted-foreground line-through">
            {row.key}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">Removing</span>
        <button
          type="button"
          onClick={onRestore}
          disabled={busy}
          className="rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          Undo
        </button>
        <span className="size-7 shrink-0" />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/25">
      {/* The key is the variable's identity, so it is editable only on a row
          that does not exist server-side yet. */}
      {row.existing ? (
        <span className={cn(CELL, "flex-1")}>
          <span className="truncate font-mono text-sm text-foreground">{row.key}</span>
        </span>
      ) : (
        <Input
          value={row.key}
          onChange={(e) => {
            onChange({ key: e.target.value })
          }}
          placeholder="name"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="h-9 min-w-0 flex-1 font-mono text-sm"
        />
      )}

      <div className={cn(CELL, "w-[46%] gap-1")}>
        {editing ? (
          <ValueField
            value={row.value ?? ""}
            disabled={!canEdit || busy}
            onChange={(v) => {
              onChange({ value: v })
            }}
          />
        ) : (
          <>
            <span
              className={cn(
                "min-w-0 flex-1 truncate px-2 text-sm",
                shown === null
                  ? "tracking-[0.2em] text-muted-foreground"
                  : "font-mono text-foreground/80",
              )}
            >
              {shown ??
                (row.storedLength === 0 ? (
                  <span className="text-xs text-muted-foreground">empty</span>
                ) : (
                  "••••••••••••"
                ))}
            </span>
            {shown !== null && (
              <button
                type="button"
                aria-label="Copy value"
                onClick={() => {
                  void navigator.clipboard.writeText(shown).then(() => {
                    setCopied(true)
                    setTimeout(() => {
                      setCopied(false)
                    }, 1200)
                  })
                }}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <Icon icon={copied ? Tick02Icon : Copy01Icon} className="size-3.5" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Tier is an editing decision, not list furniture. */}
      {editing && canEdit ? (
        <TierToggle
          tier={tier}
          disabled={busy}
          // Revealing a stored secret needs the value re-entered - reef refuses
          // the flip otherwise, so collect it here rather than 422 on save.
          needsValue={row.existing && row.serverTier === "secret" && row.value === null}
          onChange={(next) => {
            onChange({ tier: next })
          }}
        />
      ) : (
        <span className="size-7 shrink-0" />
      )}

      {canEdit ? (
        <RowMenu
          label={row.key || "variable"}
          busy={busy}
          editing={editing}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      ) : (
        <span className="size-7 shrink-0" />
      )}
    </div>
  )
}
