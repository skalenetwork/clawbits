export const MENU_SURFACE =
    "rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-lg";

export const MENU_ITEM =
    "relative flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] leading-5 text-foreground outline-hidden select-none " +
    "data-highlighted:bg-accent data-disabled:pointer-events-none data-disabled:opacity-50 " +
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export const MENU_DESTRUCTIVE =
    "data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/10 dark:data-[variant=destructive]:data-highlighted:bg-destructive/20";

export const MENU_LABEL = "px-2.5 pt-2 pb-1 text-xs text-muted-foreground";

export const MENU_SEPARATOR = "-mx-1 my-1.5 h-px bg-foreground/8";

export const MENU_SHORTCUT = "ml-auto pl-4 text-xs text-muted-foreground";
