import {useEffect, useRef} from "react";
import {useSelector} from "@tanstack/react-store";
import {NewDmDialog} from "@/components/NewDmDialog";
import {NewChannelDialog} from "@/components/NewChannelDialog";
import {NewAgentDialog} from "@/components/new-agent/NewAgentDialog";
import {BrowseChannelsDialog} from "@/components/BrowseChannelsDialog";
import {useAuth} from "@/context/AuthContext";
import {closeWizard} from "@/components/new-agent/wizardSessionStore";
import {createDialogAtom, closeCreate} from "./createStore";

/**
 * The create dialogs (new DM / channel / agent), mounted once in the app shell
 * and driven by {@link createStore}. This lets the ⌘K command palette open them
 * from its Actions group without each surface mounting its own copies. Auth-gated
 * so it stays inert on the login / public routes.
 */
export function CreateDialogs() {
    const {user} = useAuth();
    const kind = useSelector(createDialogAtom);
    // A signed-out user can't own a wizard session — clear it so a stale chip
    // can't resurrect a mismatched session after re-login. Only a real
    // signed-in → signed-out transition counts; a null user during auth
    // bootstrap (or any future transient) must not nuke a live session.
    const hadUser = useRef(false);
    useEffect(() => {
        if (user) hadUser.current = true;
        else if (hadUser.current) {
            hadUser.current = false;
            closeWizard();
        }
    }, [user]);
    if (!user) return null;
    // The dialogs only signal close (onOpenChange(false)); clear the atom then.
    const onClose = (open: boolean) => {
        if (!open) closeCreate();
    };
    return (
        <>
            <NewDmDialog open={kind === "dm"} onOpenChange={onClose} />
            <NewChannelDialog open={kind === "channel"} onOpenChange={onClose} />
            {/* Self-driven by wizardSessionStore — it minimizes rather than
                closing, so its open state outgrew the shared kind atom. */}
            <NewAgentDialog />
            <BrowseChannelsDialog open={kind === "browse"} onOpenChange={onClose} />
        </>
    );
}
