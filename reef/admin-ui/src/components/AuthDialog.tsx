import { useState } from "react"
import { KeyIcon } from "@hugeicons/core-free-icons"
import { Icon } from "@/components/Icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"

interface Props {
  open: boolean
  /** A token was already presented (pasted or remembered) and rejected. */
  rejected: boolean
  onSubmit: (token: string) => void
}

/**
 * Blocking unlock prompt shown when the Reef API rejects requests (401/403),
 * i.e. it runs with REEF_ADMIN_TOKEN set. Not dismissable — the dashboard is
 * unusable without credentials. The token is handed to lib/api and kept
 * per-tab; see setAdminToken.
 */
export function AuthDialog({ open, rejected, onSubmit }: Props) {
  const [value, setValue] = useState("")

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const t = value.trim()
    if (!t) return
    onSubmit(t)
    setValue("")
  }

  return (
    <Dialog open={open} onOpenChange={() => undefined /* auth is required — keep open */}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon icon={KeyIcon} className="size-5" />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle>Admin token</DialogTitle>
            <DialogDescription>
              This Reef requires its admin token (<code className="font-mono text-xs">REEF_ADMIN_TOKEN</code>).
              It's kept in this browser tab and only sent to the Reef API.
            </DialogDescription>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            aria-label="Reef admin token"
            placeholder="Reef admin token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {rejected && (
            <p className="text-xs text-destructive">
              Reef rejected the last token — check it and try again.
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!value.trim()}>
              Unlock
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
