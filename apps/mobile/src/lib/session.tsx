import * as SecureStore from "expo-secure-store";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, apiUrl, ApiError, auth, request } from "./api";
import type { User } from "./models";

interface Session {
  token: string;
  user: User;
  org: string | null;
}
interface SessionContext {
  session: Session | null;
  loading: boolean;
  error: string | null;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  selectOrg: (org: string) => Promise<void>;
}

const key = `clawbits.${apiUrl.replace(/[^a-zA-Z0-9.-]/g, "_")}.session.v2`;
const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async (value: Session | null) => {
    current.current = value;
    const write = writes.current
      .catch(() => undefined)
      .then(() =>
        value
          ? SecureStore.setItemAsync(key, JSON.stringify(value))
          : SecureStore.deleteItemAsync(key),
      );
    writes.current = write;
    await write;
    if (current.current === value) setSession(value);
  }, []);

  useEffect(() => {
    auth.refresh = async (previous, next) => {
      if (current.current?.token === previous)
        await save({ ...current.current, token: next });
    };
    let active = true;
    void (async () => {
      try {
        const stored = await SecureStore.getItemAsync(key);
        if (!stored || !active) return;
        const value = JSON.parse(stored) as Session;
        if (!value.token || !value.user?.id)
          throw new Error("Saved session is invalid. Please sign in again.");
        current.current = value;
        setSession(value);
        setLoading(false);
        try {
          const user = await api.me(value.token);
          if (active && current.current?.user.id === value.user.id)
            await save({ ...current.current, user });
        } catch (cause) {
          if (
            active &&
            current.current?.token === value.token &&
            cause instanceof ApiError &&
            cause.status === 401
          )
            await save(null);
        }
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not restore your session.",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      auth.refresh = undefined;
    };
  }, [save]);

  return (
    <Context
      value={{
        session,
        loading,
        error,
        signIn: async (token) => {
          const user = await api.me(token);
          await save({ token, user, org: null });
        },
        signOut: async () => {
          const token = current.current?.token;
          await save(null);
          if (token)
            void request("/api/auth/logout", token, {}).catch(() => undefined);
        },
        selectOrg: async (org) => {
          if (current.current) await save({ ...current.current, org });
        },
      }}
    >
      {children}
    </Context>
  );
}

export function useSession(): SessionContext {
  return use(Context)!;
}
