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

async function fetchPersonalOrgId(queryClient: QueryClient): Promise<string> {
  const { organizations } = await queryClient.fetchQuery({ queryKey: queryKeys.orgs, queryFn: getOrgs });
  const personal = organizations.find((org) => org.is_personal);
  if (!personal) throw new Error("No personal organization found");
  return personal.org_id;
}

const getMeOrNull = () => getMe().catch(() => null);

interface AuthState {
  user: HumanUser | null;
  activeOrgId: string | null;
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
        const personalOrg = fetchPersonalOrgId(queryClient).then(
          (orgId) => { if (!cancelled) setPersonalOrgId(orgId); },
          () => undefined,
        );
        if (!bootOrgId) await personalOrg;
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

  const installSession = async (u: HumanUser, method: string) => {
    queryClient.clear();
    setUser(u);
    const createdAt = u.created_at ? Date.parse(u.created_at) : NaN;
    track("signin-complete", {
      method,
      ...(Number.isNaN(createdAt) ? {} : { first_session: Date.now() - createdAt < 5 * 60_000 }),
    });
    await fetchPersonalOrgId(queryClient).then(
      (orgId) => {
        setPersonalOrgId(orgId);
        setActiveOrgId(orgId);
      },
      () => undefined,
    );
  };

  const logout = async () => {
    await apiLogout().catch(() => undefined);
    localStorage.removeItem(ACTIVE_ORG_KEY);
    queryClient.clear();
    setUser(null);
    setPersonalOrgId(null);
    setStoredOrgId(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        activeOrgId,
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
