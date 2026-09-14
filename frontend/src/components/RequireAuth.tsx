import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { captureReturnPath, loginPathFor } from "@/lib/returnPath";

/**
 * The auth gate without the shell, for a route that wants the app's identity
 * but none of its chrome. ``AppShell`` couples the gate to the rail, the
 * sidebar and the header, so a full-screen setup flow has nowhere to sit.
 */
export default function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );

  if (!user) return <Navigate to={loginPathFor(captureReturnPath(location))} replace />;

  return <Outlet />;
}
