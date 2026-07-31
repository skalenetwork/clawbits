import {Toaster as SonnerToaster} from "sonner";
import {useTheme} from "@/hooks/useTheme";

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

// Liquid-glass toast styling: sonner's `richColors` tints the whole toast per
// type (blue / rose / green / amber). We keep that full tint but add a heavy
// backdrop blur + semi-transparency so the surface reads as glass rather than
// a flat color block, and round the corners more generously.
export function Toaster(props: ToasterProps) {
    const {resolvedTheme} = useTheme();
    return (
        <SonnerToaster
            theme={resolvedTheme}
            position="bottom-center"
            offset={12}
            mobileOffset={12}
            richColors
            closeButton
            style={{"--width": "400px"} as React.CSSProperties}
            toastOptions={{
                classNames: {
                    toast:
                        "group/toast backdrop-blur-2xl !rounded-xl !shadow-none " +
                        "!border !border-current/15 !py-2.5 !px-4 !gap-2 !min-h-0 " +
                        "!w-max !max-w-full !left-1/2 !-translate-x-1/2 !justify-center",
                    title: "font-medium text-sm leading-tight",
                    description: "text-xs opacity-80 leading-snug",
                    closeButton:
                        "opacity-0 group-hover/toast:opacity-100 transition-opacity " +
                        "!bg-current/10 !text-current !border !border-current/20 backdrop-blur-md " +
                        "!size-4",
                    icon: "!size-3.5",
                },
            }}
            {...props}
        />
    );
}
