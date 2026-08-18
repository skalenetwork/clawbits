import { useState } from "react";
import { Button } from "@/components/ui/button";
import { socialAuthUrl, type OAuthProvider } from "@/lib/api";
import { beginDesktopOAuth, isDesktop } from "@/lib/desktop";
import { useSearchParams } from "react-router-dom";
import { NEXT_PARAM, safeReturnPath } from "@/lib/returnPath";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export default function OAuthButtons({ label }: { label: string }) {
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [params] = useSearchParams();

  const handle = async (provider: OAuthProvider) => {
    setBusy(provider);
    const path = socialAuthUrl(provider);
    // Where to land afterwards, for a visitor bounced here off a deep link.
    // The web leg hands it to the backend, which parks it in a cookie for the
    // WorkOS round-trip; it is validated there again before it is used.
    const next = safeReturnPath(params.get(NEXT_PARAM));
    if (isDesktop) {
      // Open the OAuth flow in the user's default system browser; the
      // backend's `?desktop=1` marker causes the final callback to redirect
      // into `clawbits://oauth-callback?token=…`, which is captured by the
      // deep-link listener in desktop.ts.
      //
      // `client_state` is a nonce the backend round-trips back to us in
      // that deep link. Without it the listener has no way to tell our
      // own callback from one any web page can fire at the scheme
      // handler, so it refuses tokens that don't echo it.
      const apiBase = (import.meta.env.VITE_CLAWBITS_API_URL as string | undefined) || window.location.origin;
      const clientState = beginDesktopOAuth();
      const fullUrl = `${apiBase}${path}?desktop=1&client_state=${encodeURIComponent(clientState)}`;
      try {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(fullUrl);
      } finally {
        // Browser opens externally — re-enable the button so the user can
        // retry if they cancel and come back.
        setBusy(null);
      }
      return;
    }
    // Web: hard-navigate to backend start, browser handles the rest.
    window.location.href = next
      ? `${path}?${NEXT_PARAM}=${encodeURIComponent(next)}`
      : path;
  };

  return (
    <>
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center" aria-hidden="true">
          <div className="w-full border-t" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-2 text-xs tracking-wider text-muted-foreground">
            or
          </span>
        </div>
      </div>

      <div className="grid gap-3">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-12 w-full text-base"
          disabled={busy !== null}
          onClick={() => { handle("google"); }}
        >
          <GoogleIcon />
          <span>{busy === "google" ? "Redirecting\u2026" : `${label} with Google`}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-12 w-full text-base"
          disabled={busy !== null}
          onClick={() => { handle("github"); }}
        >
          <GithubIcon />
          <span>{busy === "github" ? "Redirecting\u2026" : `${label} with GitHub`}</span>
        </Button>
      </div>
    </>
  );
}
