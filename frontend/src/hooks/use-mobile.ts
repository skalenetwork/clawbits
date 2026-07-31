import * as React from "react"

import { MOBILE_BREAKPOINT, currentViewport } from "@/lib/viewport"

/**
 * Reads the viewport synchronously so the FIRST render is correct — seeded from
 * the ``html[data-viewport]`` attribute that ``setupViewportClass()`` stamps in
 * main.tsx before React mounts. This is what keeps the responsive shell from
 * flashing the desktop layout (and double-mounting ChannelPage) on phones.
 */
function readInitial(): boolean {
  if (typeof document !== "undefined") {
    const v = document.documentElement.dataset.viewport
    if (v === "mobile") return true
    if (v === "desktop") return false
  }
  return currentViewport() === "mobile"
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(readInitial)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    // matchMedia "change" is the canonical signal; "resize" is a belt-and-
    // suspenders backup (some environments don't reliably fire the MQL event).
    mql.addEventListener("change", onChange)
    window.addEventListener("resize", onChange)
    onChange()
    return () => {
      mql.removeEventListener("change", onChange)
      window.removeEventListener("resize", onChange)
    }
  }, [])

  return isMobile
}
