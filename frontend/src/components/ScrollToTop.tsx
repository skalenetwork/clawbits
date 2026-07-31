import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Scrolls the window to the top whenever the route's pathname changes.
 * In-page anchor jumps (#section) keep working because we only watch
 * pathname, not hash. Render once inside <BrowserRouter>.
 */
export function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}
