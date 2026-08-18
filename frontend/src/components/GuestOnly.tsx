import { Navigate, Outlet, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { DEFAULT_LANDING, NEXT_PARAM, safeReturnPath } from "../lib/returnPath";

/**
 * Route guard for pages that should only be visible when *not* signed in
 * (``/login``, ``/verify-email``). Already-authenticated visitors are
 * bounced to ``/home``. Mirrors the inverse guard in :file:`AppShell.tsx`.
 *
 * Renders a spinner while ``AuthContext`` is bootstrapping so we never
 * flash the login form to a user who's actually signed in.
 */
export default function GuestOnly() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  // Honour ?next= here too. Without it, a signed-in user following a deep
  // link that had been bounced to /login lands on /home instead of the thing
  // they clicked - the same bug this feature exists to fix, one step later.
  if (user) {
    return <Navigate to={safeReturnPath(params.get(NEXT_PARAM)) ?? DEFAULT_LANDING} replace />;
  }

  return <Outlet />;
}
