import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  deleteMyAccount as apiDeleteMyAccount,
  getMe,
  logout as apiLogout,
  sendMagicCode as apiSendMagicCode,
  socialAuthStartUrl,
  verifyMagicCode as apiVerifyMagicCode,
  type HumanUser,
  type SocialProvider,
} from '@/lib/api';
import { queryClient } from '@/lib/query-client';

/** Deep-link target the backend HTML bridge fires after a successful
 *  OAuth callback. Mirrors the ``clawbits`` scheme registered in
 *  ``app.json``; the path must match what ``social_callback`` emits
 *  for ``state.startswith("mobile.")``. */
const SOCIAL_RETURN_URL = 'clawbits://oauth-callback';

const TOKEN_KEY = 'clawbits.session.v1';
const ORG_KEY = 'clawbits.selected_org.v1';
// Tracks which human the persisted query cache belongs to. If the
// restored token resolves to a *different* user (token swapped behind
// our back, dev-tool sign-in), we evict the cache before any screen
// renders so we never paint another user's channels.
const CACHE_OWNER_KEY = 'clawbits.cache_owner.v1';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  sendMagicCode: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Permanently delete the account, then tear down the local session
   *  exactly like ``signOut`` (token, org, cache-owner keys + query cache).
   *  Rejects WITHOUT tearing down if the server refuses (e.g. 409 guard) so
   *  the caller can show the reason and the still-valid session survives. */
  deleteAccount: () => Promise<void>;
  status: AuthStatus;
  token: string | null;
  user: HumanUser | null;
  verifyMagicCode: (email: string, code: string) => Promise<void>;
  /** Start an OAuth flow in an in-app browser session, parse the token
   *  from the resulting deep link, and complete sign-in. Resolves to
   *  ``true`` on success, ``false`` if the user closed the browser
   *  themselves; throws only on real failures (network, malformed
   *  callback, missing token) so callers can render those without
   *  also treating user-initiated cancels as errors. */
  socialSignIn: (provider: SocialProvider) => Promise<boolean>;
  /** Complete sign-in from a deep-link URL handled outside the
   *  ``socialSignIn`` promise — used by the cold-start fallback in the
   *  root layout when the OS relaunches the app via the callback URL
   *  while the in-app browser session was suspended. */
  completeSocialFromUrl: (url: string) => Promise<boolean>;
  selectedOrgId: string | null;
  setSelectedOrgId: (id: string | null) => Promise<void>;
  /** Merge a partial update into the cached user. Used by the settings
   *  pages after a profile/avatar PATCH so the rest of the app reflects
   *  the change without a round-trip through ``getMe``. */
  patchUser: (patch: Partial<HumanUser>) => void;
}

/** Pull the ``token`` query param out of a ``clawbits://oauth-callback``
 *  URL. Returns ``null`` if the URL isn't an OAuth callback or carries
 *  no token. Implemented manually because ``new URL()`` in the Hermes
 *  engine doesn't always parse custom-scheme URLs reliably. */
function tokenFromCallbackUrl(url: string): string | null {
  if (!url.startsWith('clawbits://oauth-callback')) return null;
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return null;
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<HumanUser | null>(null);
  const [selectedOrgId, setSelectedOrgIdState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const [stored, storedOrg] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(ORG_KEY),
      ]);

      if (!cancelled && storedOrg) {
        setSelectedOrgIdState(storedOrg);
      }

      if (!stored) {
        if (!cancelled) setStatus('anonymous');
        return;
      }

      try {
        const me = await getMe(stored);
        if (cancelled) return;
        const previousOwner = await SecureStore.getItemAsync(CACHE_OWNER_KEY);
        const currentOwner = String(me.id);
        if (previousOwner !== currentOwner) {
          queryClient.clear();
          await SecureStore.setItemAsync(CACHE_OWNER_KEY, currentOwner);
        }
        setToken(stored);
        setUser(me);
        setStatus('authenticated');
      } catch {
        await Promise.all([
          SecureStore.deleteItemAsync(TOKEN_KEY),
          SecureStore.deleteItemAsync(CACHE_OWNER_KEY),
        ]);
        queryClient.clear();
        if (cancelled) return;
        setToken(null);
        setUser(null);
        setStatus('anonymous');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrates a fresh session token end-to-end: dump any stale cache,
  // persist the token + cache-owner key, fetch the user, flip state to
  // authenticated. Shared by the in-app browser flow and the cold-start
  // deep-link fallback so neither path can drift from the other.
  const adoptToken = useCallback(async (nextToken: string) => {
    const me = await getMe(nextToken);
    queryClient.clear();
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, nextToken),
      SecureStore.setItemAsync(CACHE_OWNER_KEY, String(me.id)),
    ]);
    setToken(nextToken);
    setUser(me);
    setStatus('authenticated');
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    sendMagicCode: apiSendMagicCode,
    socialSignIn: async (provider) => {
      const startUrl = socialAuthStartUrl(provider);
      const result = await WebBrowser.openAuthSessionAsync(
        startUrl,
        SOCIAL_RETURN_URL,
      );
      if (result.type === 'cancel' || result.type === 'dismiss') {
        return false;
      }
      if (result.type !== 'success' || !result.url) {
        throw new Error('Sign-in did not complete');
      }
      const nextToken = tokenFromCallbackUrl(result.url);
      if (!nextToken) {
        throw new Error('Server did not return a session token');
      }
      await adoptToken(nextToken);
      return true;
    },
    completeSocialFromUrl: async (url) => {
      const nextToken = tokenFromCallbackUrl(url);
      if (!nextToken) return false;
      try {
        await adoptToken(nextToken);
        return true;
      } catch {
        return false;
      }
    },
    signOut: async () => {
      try {
        await apiLogout(token);
      } catch {
        // Local sign-out still wins.
      }
      await Promise.all([
        SecureStore.deleteItemAsync(TOKEN_KEY),
        SecureStore.deleteItemAsync(ORG_KEY),
        SecureStore.deleteItemAsync(CACHE_OWNER_KEY),
      ]);
      queryClient.clear();
      setToken(null);
      setUser(null);
      setSelectedOrgIdState(null);
      setStatus('anonymous');
    },
    deleteAccount: async () => {
      // Hard-delete on the server first. If it throws (network, or a 409
      // guard like "you still operate agents"), let it propagate: we must
      // NOT wipe a session that's still valid, and the caller renders the
      // backend's reason. Only on success do we tear down locally — the
      // session no longer exists server-side, so skip the apiLogout call.
      await apiDeleteMyAccount(token);
      await Promise.all([
        SecureStore.deleteItemAsync(TOKEN_KEY),
        SecureStore.deleteItemAsync(ORG_KEY),
        SecureStore.deleteItemAsync(CACHE_OWNER_KEY),
      ]);
      queryClient.clear();
      setToken(null);
      setUser(null);
      setSelectedOrgIdState(null);
      setStatus('anonymous');
    },
    status,
    token,
    user,
    verifyMagicCode: async (email: string, code: string) => {
      const nextUser = await apiVerifyMagicCode(email, code);
      if (!nextUser.token) {
        throw new Error('Server did not return a mobile session token');
      }
      // Fresh sign-in: dump any stale cache from a previous account
      // before the new user's queries fan out.
      queryClient.clear();
      await Promise.all([
        SecureStore.setItemAsync(TOKEN_KEY, nextUser.token),
        SecureStore.setItemAsync(CACHE_OWNER_KEY, String(nextUser.id)),
      ]);
      setToken(nextUser.token);
      setUser(nextUser);
      setStatus('authenticated');
    },
    selectedOrgId,
    setSelectedOrgId: async (id) => {
      setSelectedOrgIdState(id);
      if (id == null) {
        await SecureStore.deleteItemAsync(ORG_KEY);
      } else {
        await SecureStore.setItemAsync(ORG_KEY, id);
      }
    },
    patchUser: (patch) => {
      setUser((prev) => (prev ? { ...prev, ...patch } : prev));
    },
  }), [status, token, user, selectedOrgId, adoptToken]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}
