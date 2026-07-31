import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

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

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (user) return <Navigate to="/home" replace />;

  return <Outlet />;
}
