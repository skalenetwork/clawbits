import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HumanUser } from "../lib/api";
import { track } from "../lib/analytics";
import {
  devLogin,
  getMe,
  getPersonalOrgId,
  listMmChannels,
  logout as apiLogout,
  sendMagicCode,
  verifyMagicCode,
  verifySocialEmail,
} from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

const ACTIVE_ORG_KEY = "fc_active_org_id";

interface AuthState {
  user: HumanUser | null;
  activeOrgId: string | null;
  setActiveOrgId: (orgId: string) => void;
  loading: boolean;
  /** Send a magic-auth code to the email. */
  sendMagic: (email: string) => Promise<void>;
  /** Verify the code; on success the cookie is set and ``user`` populated. */
  verifyMagic: (email: string, code: string) => Promise<void>;
  /** Complete a social sign-in that WorkOS gated behind email verification.
   *  Pending-auth token is in an httpOnly cookie; we only send the code. */
  verifySocialEmailCode: (code: string) => Promise<void>;
  /** Local-dev only: backend-gated sign-in without WorkOS round trip. */
  signInDev: (email: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Apply a server-side profile update to local auth state. Scoped to
   *  fields the profile editor can change — currently just display_name. */
  applyProfileUpdate: (user: HumanUser) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<HumanUser | null>(null);
  const [personalOrgId, setPersonalOrgId] = useState<string | null>(null);
  const [storedOrgId, setStoredOrgId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_ORG_KEY),
  );
  // Fall back to the personal org whenever nothing is stored — covers the
  // first login (no localStorage entry yet) without relying on an effect.
  const activeOrgId = storedOrgId ?? personalOrgId;
  const [loading, setLoading] = useState(true);

  // Bootstrap: try to fetch /api/auth/me using the cookie. If 401, we're
  // not signed in — that's the login state.
  //
  // Retry once on 401: parallel page-load requests can race on the
  // WorkOS access-token refresh. The "winner" lands a fresh ``Set-Cookie``
  // on its response; the "losers" return 401 with no Set-Cookie. If the
  // bootstrap ``getMe()`` is one of the losers, the cookie jar may
  // already have a fresh cookie by the time we get here, but it landed
  // a few hundred ms after our request was sent. A single retry with a
  // small delay re-issues the request with the now-current cookie and
  // self-heals the brief race window.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const tryGetMe = async (): Promise<HumanUser | null> => {
        try {
          return await getMe();
        } catch {
          return null;
        }
      };

      // Warm the chat list IN PARALLEL with the auth handshake. The shell
      // renders a spinner until ``loading`` clears, so nothing downstream can
      // even mount a query until ``getMe`` resolves — which used to make the
      // sidebar's fetch the third request in a strict chain (me -> orgs ->
      // channels) on every cold load. A returning user's active org is already
      // in localStorage, so the biggest request of the three doesn't have to
      // wait to learn something we know. If the cookie turns out to be dead
      // the prefetch 401s into a discarded cache entry and we land on /login
      // regardless; the stored id only exists after a previous sign-in.
      // Read the jar directly rather than the state mirror: this effect runs
      // once on mount and must not re-run when the user switches org later.
      const bootOrgId = localStorage.getItem(ACTIVE_ORG_KEY);
      if (bootOrgId) {
        void queryClient.prefetchQuery({
          queryKey: queryKeys.mm.channels(bootOrgId),
          queryFn: () => listMmChannels(bootOrgId),
        });
      }

      try {
        let me = await tryGetMe();
        if (me === null) {
          // Brief window for a sibling request's Set-Cookie to land in
          // the jar. 250ms is comfortably longer than the longest WorkOS
          // refresh latency we've seen but short enough to feel instant.
          await new Promise((r) => setTimeout(r, 250));
          if (cancelled) return;
          me = await tryGetMe();
        }
        if (cancelled) return;
        if (me === null) {
          setUser(null);
          return;
        }
        setUser(me);
        // The personal org is only load-bearing as the fallback for
        // ``activeOrgId`` when nothing is stored — i.e. first login. When we
        // do have a stored org, resolving it is not on the critical path, so
        // it runs in the background instead of holding the whole app behind a
        // second round-trip.
        const resolvePersonalOrg = (async () => {
          try {
            const orgId = await getPersonalOrgId();
            if (!cancelled) setPersonalOrgId(orgId);
          } catch { /* personal org may not exist yet - ignore */ }
        })();
        if (!bootOrgId) await resolvePersonalOrg;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Mount-only. ``queryClient`` is a stable singleton; the boot org is read
    // from localStorage inside the effect so an org switch never re-runs it.
  }, [queryClient]);

  const setActiveOrgId = (orgId: string) => {
    localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    setStoredOrgId(orgId);
  };

  const sendMagic = async (email: string) => {
    await sendMagicCode(email);
  };

  /**
   * Every successful authentication funnels through here - magic code, social,
   * and dev sign-in alike - which is why the one conversion event lives here
   * rather than in LoginPage. Anything per-flow would miss the other flows.
   *
   * `first_session` is derived from `created_at` rather than from a dedicated
   * "is new" flag the API does not have: an account made in the last five
   * minutes is one that was made by this sign-in. When the field is absent
   * (legacy session payloads) the property is OMITTED, not guessed - a false
   * "returning user" is worse than a gap.
   *
   * No email, no user id, no org. See lib/analytics.ts.
   */
  const trackSignIn = (u: HumanUser, method: string) => {
    const createdAt = u.created_at ? Date.parse(u.created_at) : NaN;
    const fresh = Number.isNaN(createdAt) ? undefined : Date.now() - createdAt < 5 * 60_000;
    track("signin-complete", { method, ...(fresh === undefined ? {} : { first_session: fresh }) });
  };

  const installSession = async (u: HumanUser, method: string) => {
    queryClient.clear();
    setUser(u);
    trackSignIn(u, method);
    try {
      const orgId = await getPersonalOrgId();
      setPersonalOrgId(orgId);
      // Force-reset the active org so a stale value left in localStorage
      // by a previous account can't strand the sidebar in "Loading…".
      localStorage.setItem(ACTIVE_ORG_KEY, orgId);
      setStoredOrgId(orgId);
    } catch { /* ignore */ }
  };

  const verifyMagic = async (email: string, code: string) => {
    const u = await verifyMagicCode(email, code);
    await installSession(u, "magic-code");
  };

  const verifySocialEmailCode = async (code: string) => {
    const u = await verifySocialEmail(code);
    await installSession(u, "social");
  };

  const signInDev = async (email: string, displayName?: string) => {
    const u = await devLogin(email, displayName);
    await installSession(u, "dev");
  };

  const logout = async () => {
    try { await apiLogout(); } catch { /* still clear local state */ }
    localStorage.removeItem(ACTIVE_ORG_KEY);
    queryClient.clear();
    setUser(null);
    setPersonalOrgId(null);
    setStoredOrgId(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user, activeOrgId, setActiveOrgId,
        loading, sendMagic, verifyMagic, verifySocialEmailCode,
        signInDev, logout,
        applyProfileUpdate: setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- hook must co-locate with provider
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
