import { useLocation, useNavigate } from "react-router"
import {
  ComputerIcon as Monitor,
  Home03Icon,
  Moon02Icon as Moon,
  PackageIcon,
  Settings02Icon,
  Sun01Icon as Sun,
  Tick01Icon as Check,
} from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"
import { useTheme } from "@/hooks/useTheme"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/Icon"
import { ReefMark } from "@/components/ReefMark"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

function RailButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconSvgElement
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex size-9 items-center justify-center rounded-lg transition duration-100 active:scale-90",
              active
                ? "bg-sidebar-foreground/10 text-sidebar-foreground"
                : "text-muted-foreground hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
            )}
          >
            <Icon icon={icon} className="size-[18px]" />
          </button>
        }
      />
      <TooltipContent side="right" sideOffset={8} className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Thin, always-present icon rail down the left edge of the app. Reef is a
 * single-section tool, so the rail carries identity + global controls: the Reef
 * mark (→ home) and a Home nav icon at the top, with the theme switcher and a
 * runtime-health dot pinned at the bottom. The opaque content card sits to its
 * right; the rail floats over --background.
 */
export function AppRail() {
  const navigate = useNavigate()
  const location = useLocation()
  // Reef is single-section: Home is the fleet, and the agent detail
  // (/agents/:id) lives under it — so Home stays active there too.
  const onHome = location.pathname === "/" || location.pathname.startsWith("/agents")
  const onImages = location.pathname.startsWith("/images")
  const onSettings = location.pathname.startsWith("/settings")
  const { theme, setTheme } = useTheme()
  const themeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor

  return (
    <nav
      aria-label="Primary"
      data-vt-sidebar=""
      className="flex w-12 shrink-0 flex-col items-center gap-1 pt-3 pb-2"
    >
      {/* Brand → home */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => navigate("/")}
              aria-label="Reef home"
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition duration-100 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground active:scale-90"
            >
              <ReefMark className="size-5" />
            </button>
          }
        />
        <TooltipContent side="right" sideOffset={8} className="text-xs">
          Reef
        </TooltipContent>
      </Tooltip>

      {/* Divider — sets the brand apart from the nav cluster below, mirroring
          the clawbits rail's identity/nav split. */}
      <div className="mt-1 mb-1.5 h-px w-7 shrink-0 bg-sidebar-border" />

      {/* Primary nav */}
      <RailButton icon={Home03Icon} label="Home" active={onHome} onClick={() => navigate("/")} />
      <RailButton
        icon={PackageIcon}
        label="Images"
        active={onImages}
        onClick={() => navigate("/images")}
      />

      {/* Bottom-pinned: appearance + settings (settings sits at the very bottom,
          matching the clawbits rail). */}
      <div className="mt-auto flex flex-col items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            title="Appearance"
            aria-label="Appearance"
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-hidden transition duration-100 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground active:scale-90 data-[pressed]:scale-90"
          >
            <Icon icon={themeIcon} className="size-[18px]" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" sideOffset={8} className="min-w-40">
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <Icon icon={Sun} className="size-4" /> Light
              {theme === "light" && (
                <Icon icon={Check} className="ml-auto size-4 text-muted-foreground" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <Icon icon={Moon} className="size-4" /> Dark
              {theme === "dark" && (
                <Icon icon={Check} className="ml-auto size-4 text-muted-foreground" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <Icon icon={Monitor} className="size-4" /> System
              {theme === "system" && (
                <Icon icon={Check} className="ml-auto size-4 text-muted-foreground" />
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <RailButton
          icon={Settings02Icon}
          label="Settings"
          active={onSettings}
          onClick={() => navigate("/settings")}
        />
      </div>
    </nav>
  )
}
