import type {ReactNode} from "react";
import type {IconSvgElement} from "@hugeicons/react";
import {Icon} from "@/components/Icon";

/** Quiet sentence-case section header — small, secondary, icon-led. Shared by
 *  the automations gallery and the automation detail page so sections read
 *  identically everywhere. */
export function SectionHeader({icon, children}: {icon: IconSvgElement; children: ReactNode}) {
    return (
        <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Icon icon={icon} className="size-4 shrink-0"/>
            {children}
        </p>
    );
}
