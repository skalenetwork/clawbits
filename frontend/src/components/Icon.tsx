import {HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement} from "@hugeicons/react";
import type {LucideIcon} from "lucide-react";

/** A hugeicons glyph (an element array) or a lucide icon component. */
export type AppIcon = IconSvgElement | LucideIcon;

export function Icon({icon, strokeWidth = 2, ...props}: Omit<HugeiconsIconProps, "icon"> & {icon: AppIcon}) {
    if (Array.isArray(icon)) return <HugeiconsIcon icon={icon as IconSvgElement} strokeWidth={strokeWidth} {...props} />;
    const Lucide = icon as LucideIcon;
    return <Lucide strokeWidth={strokeWidth} {...props} />;
}
