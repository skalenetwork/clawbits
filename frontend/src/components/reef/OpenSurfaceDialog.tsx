/**
 * OpenSurfaceDialog — collects the one-time access password (Reef no longer
 * reveals it after creation) and opens the agent's Control UI or scoped web
 * terminal in a new tab. The surface URL is fetched up front (from the Reef
 * detail) so the `window.open` fires synchronously on submit — both popup-safe
 * and user-gesture-bound. The password only builds the auto-auth URL and is
 * never stored. Shared by the Reef settings fleet + the agent home page.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  LinkSquare02Icon as OpenExternal,
  TerminalIcon as Terminal,
} from "@hugeicons/core-free-icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/Icon";
import { toast } from "@/lib/toast";
import { reefDetail, reefReveal, surfaceAuthUrl, terminalAuthUrl, ReefAuthError } from "@/lib/reefApi";

export function OpenSurfaceDialog({
  target,
  apiUrl,
  onClose,
  onAuthReject,
}: {
  target: { id: string; surface: "ui" | "terminal" };
  apiUrl: string | null;
  onClose: () => void;
  onAuthReject: () => void;
}) {
  // Mounted only while open (the parent gates on `openTarget`), so password
  // state is fresh per open — no reset effect needed.
  const [password, setPassword] = useState("");

  // Fetch the (non-secret) surface URL while the operator types the password.
  const detailQuery = useQuery({
    queryKey: ["reef-surface-detail", apiUrl, target.id],
    queryFn: () => reefDetail(apiUrl ?? "", target.id),
    enabled: Boolean(apiUrl),
    retry: false,
  });

  useEffect(() => {
    if (detailQuery.error instanceof ReefAuthError) {
      onAuthReject();
      toast.error("Reef rejected the token - re-enter it");
      onClose();
    }
  }, [detailQuery.error, onAuthReject, onClose]);

  // Recover the one-time access password from the running guest (Reef doesn't
  // persist it, but the admin `/reveal` endpoint reads it back), and drop it
  // straight into the field so the operator can open without hunting for it.
  const reveal = useMutation({
    mutationFn: () => reefReveal(apiUrl ?? "", target.id),
    onSuccess: (access) => {
      if (access.password) {
        setPassword(access.password);
        toast.success("Password revealed from the running agent");
      } else {
        toast.error("This agent has no saved password to reveal");
      }
    },
    onError: (e) => {
      if (e instanceof ReefAuthError) {
        onAuthReject();
        onClose();
      }
      toast.error("Couldn't reveal the saved password");
    },
  });

  const isUi = target.surface === "ui";
  const access = detailQuery.data?.access ?? null;
  // Hermes' primary surface is a basic-auth dashboard, not a `#token=` Control
  // UI — the reef detail's access.kind knows, even before the agent's first
  // liveness ping.
  const isHermes = access?.kind === "hermes";
  const uiLabel = isHermes ? "dashboard" : "Control UI";
  const surfaceUrl = isUi ? access?.url ?? null : access?.terminal_url ?? null;
  const missing = detailQuery.isSuccess && !surfaceUrl;

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const pw = password.trim();
    if (!pw || !surfaceUrl) return;
    const url = isUi ? surfaceAuthUrl(access?.kind, surfaceUrl, pw) : terminalAuthUrl(surfaceUrl, pw);
    window.open(url, "_blank", "noopener,noreferrer");
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Icon icon={isUi ? OpenExternal : Terminal} className="text-muted-foreground" />
            Open {isUi ? uiLabel : "terminal"}
          </DialogTitle>
          <DialogDescription>
            Enter the access password shown when this agent was created. It's used
            only to open the {isUi ? uiLabel : "terminal"} and is never stored.
            {(!isUi || isHermes) && (
              <>
                {" "}The {isUi ? "dashboard" : "terminal"}&apos;s username is{" "}
                <span className="font-mono text-foreground">reef</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            aria-label="Access password"
            placeholder="Access password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); }}
            disabled={missing}
          />
          {missing && (
            <p className="text-xs text-destructive">
              This agent has no {isUi ? uiLabel : "terminal"} surface.
            </p>
          )}
          {!missing && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
              onClick={() => { reveal.mutate(); }}
              disabled={reveal.isPending || !surfaceUrl}
            >
              {reveal.isPending ? "Revealing…" : "Lost it? Reveal saved password"}
            </button>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password.trim() || !surfaceUrl || detailQuery.isLoading}>
              <Icon icon={isUi ? OpenExternal : Terminal} className="size-4" />
              {detailQuery.isLoading ? "Loading…" : "Open"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
