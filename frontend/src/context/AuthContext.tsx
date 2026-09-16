import { createContext, startTransition, useContext, useState, useEffect, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HumanUser } from "../lib/api";
import { track } from "../lib/analytics";
import {
  devLogin,
  getMe,
  getOrgs,
  listMmChannels,
  logout as apiLogout,
  sendMagicCode,
  verifyMagicCode,
  verifySocialEmail,
} from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import { setDesktopSessionLive } from "../lib/desktop";

const ACTIVE_ORG_KEY = "fc_active_org_id";

/** The personal org, and whether there is any other org to choose between.
 *  With one there is nothing to ask, so a sign-in opens it; with several the
 *  choice stays open for the org picker. */
async function fetchOrgs(queryClient: QueryClient): Promise<{ personalOrgId: string; several: boolean }> {
  const { organizations } = await queryClient.fetchQuery({ queryKey: queryKeys.orgs, queryFn: getOrgs });
  const personal = organizations.find((org) => org.is_personal);
  if (!personal) throw new Error("No personal organization found");
  return { personalOrgId: personal.org_id, several: organizations.length > 1 };
}

const getMeOrNull = () => getMe().catch(() => null);

interface AuthState {
  user: HumanUser | null;
  activeOrgId: string | null;
  /** Signed in with several orgs and none opened yet: the org picker asks. */
  needsOrgPick: boolean;
  setActiveOrgId: (orgId: string) => void;
  loading: boolean;
  sendMagic: (email: string) => Promise<void>;
  verifyMagic: (email: string, code: string) => Promise<void>;
  verifySocialEmailCode: (code: string) => Promise<void>;
  signInDev: (email: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  applyProfileUpdate: (user: HumanUser) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<HumanUser | null>(null);
  const [personalOrgId, setPersonalOrgId] = useState<string | null>(null);
  const [storedOrgId, setStoredOrgId] = useState(() => localStorage.getItem(ACTIVE_ORG_KEY));
  const activeOrgId = storedOrgId ?? personalOrgId;
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // A returning user's org is known up front, so the chat list loads in parallel with the auth check.
    const bootOrgId = localStorage.getItem(ACTIVE_ORG_KEY);
    if (bootOrgId) {
      void queryClient.prefetchQuery({
        queryKey: queryKeys.mm.channels(bootOrgId),
        queryFn: () => listMmChannels(bootOrgId),
      });
    }
    void (async () => {
      let me = await getMeOrNull();
      if (!me) {
        // A parallel request can win the WorkOS token refresh and land the fresh cookie a beat later.
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (cancelled) return;
        me = await getMeOrNull();
      }
      if (cancelled) return;
      if (me) {
        setUser(me);
        const orgs = fetchOrgs(queryClient).then(
          ({ personalOrgId, several }) => {
            if (cancelled) return;
            setPersonalOrgId(personalOrgId);
            if (bootOrgId || several) return;
            localStorage.setItem(ACTIVE_ORG_KEY, personalOrgId);
            setStoredOrgId(personalOrgId);
          },
          () => undefined,
        );
        if (!bootOrgId) await orgs;
      }
      if (!cancelled) startTransition(() => { setLoading(false); });
    })();
    return () => { cancelled = true; };
  }, [queryClient]);

  useEffect(() => { setDesktopSessionLive(user !== null); }, [user]);

  const setActiveOrgId = (orgId: string) => {
    localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    setStoredOrgId(orgId);
  };

  const forgetActiveOrg = () => {
    localStorage.removeItem(ACTIVE_ORG_KEY);
    setStoredOrgId(null);
  };

  const installSession = async (u: HumanUser, method: string) => {
    queryClient.clear();
    forgetActiveOrg();
    const createdAt = u.created_at ? Date.parse(u.created_at) : NaN;
    track("signin-complete", {
      method,
      ...(Number.isNaN(createdAt) ? {} : { first_session: Date.now() - createdAt < 5 * 60_000 }),
    });
    // Orgs before the user, so the first signed-in render already knows whether to ask.
    await fetchOrgs(queryClient).then(
      ({ personalOrgId, several }) => {
        setPersonalOrgId(personalOrgId);
        if (!several) setActiveOrgId(personalOrgId);
      },
      () => undefined,
    );
    setUser(u);
  };

  const logout = async () => {
    await apiLogout().catch(() => undefined);
    forgetActiveOrg();
    queryClient.clear();
    setUser(null);
    setPersonalOrgId(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        activeOrgId,
        needsOrgPick: personalOrgId !== null && storedOrgId === null,
        setActiveOrgId,
        loading,
        sendMagic: sendMagicCode,
        verifyMagic: async (email, code) => { await installSession(await verifyMagicCode(email, code), "magic-code"); },
        verifySocialEmailCode: async (code) => { await installSession(await verifySocialEmail(code), "social"); },
        signInDev: async (email, displayName) => { await installSession(await devLogin(email, displayName), "dev"); },
        logout,
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
