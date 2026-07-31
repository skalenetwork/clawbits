import {HugeiconsIcon, type HugeiconsIconProps} from "@hugeicons/react";

export function Icon({strokeWidth = 2, ...props}: HugeiconsIconProps) {
    return <HugeiconsIcon strokeWidth={strokeWidth} {...props} />;
}
