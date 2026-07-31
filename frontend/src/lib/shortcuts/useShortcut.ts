import {useEffect} from "react";
import {registerShortcut, type ShortcutSpec} from "./store";

/**
 * Register a global keyboard shortcut for the lifetime of the calling
 * component. The spec object is captured by ref so callers don't need to
 * memoise `run` — handler always sees the latest closure.
 */
export function useShortcut(spec: ShortcutSpec): void {
    useEffect(() => {
        const unregister = registerShortcut(spec);
        return unregister;
        // We re-register if the binding or id changes; `run`/`when` updates
        // are picked up via store mutation on each render path.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spec.id, spec.keys, spec.hint?.label, spec.hint?.group]);

    // Mirror latest run/when into the store each render so closures stay fresh.
    useEffect(() => {
        registerShortcut(spec);
        // Intentionally no cleanup — unmount cleanup is handled above.
    });
}
