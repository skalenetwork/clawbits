/**
 * Shared "liquid glass" surface for floating menus — dropdowns, context
 * menus, and their submenus. A translucent ``bg-popover`` fill with a heavy
 * backdrop blur (so the menu picks up the colors/wallpaper behind it), a soft
 * drop shadow, a hairline inset ring, and a faint highlight line along the top
 * edge for a glassy sheen.
 *
 * ``relative`` is required for the ``before`` highlight; ``p-1.5`` is the
 * standard item-list padding. Compose it with each menu's own positioning,
 * sizing, and open/close animation classes via ``cn()``.
 */
export const MENU_SURFACE =
    "relative rounded-2xl bg-popover/85 p-1.5 text-popover-foreground " +
    "shadow-[0_18px_45px_-12px_rgba(0,0,0,0.45),0_2px_6px_-2px_rgba(0,0,0,0.25)] " +
    "ring-1 ring-inset ring-foreground/[0.06] backdrop-blur-2xl backdrop-saturate-150 " +
    "supports-[backdrop-filter]:bg-popover/70 " +
    "before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px " +
    "before:bg-gradient-to-r before:from-transparent before:via-foreground/15 before:to-transparent";
