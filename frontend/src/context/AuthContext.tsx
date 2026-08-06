import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HumanUser } from "../lib/api";
import {
  devLogin,
  getMe,
  getPersonalOrgId,
  logout as apiLogout,
  sendMagicCode,
  verifyMagicCode,
  verifySocialEmail,
} from "../lib/api";

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
        try {
          const orgId = await getPersonalOrgId();
          if (!cancelled) setPersonalOrgId(orgId);
        } catch { /* personal org may not exist yet - ignore */ }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setActiveOrgId = (orgId: string) => {
    localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    setStoredOrgId(orgId);
  };

  const sendMagic = async (email: string) => {
    await sendMagicCode(email);
  };

  const installSession = async (u: HumanUser) => {
    queryClient.clear();
    setUser(u);
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
    await installSession(u);
  };

  const verifySocialEmailCode = async (code: string) => {
    const u = await verifySocialEmail(code);
    await installSession(u);
  };

  const signInDev = async (email: string, displayName?: string) => {
    const u = await devLogin(email, displayName);
    await installSession(u);
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
