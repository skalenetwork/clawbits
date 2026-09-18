import {useSelector} from "@tanstack/react-store";
import {NewDmDialog} from "@/components/NewDmDialog";
import {NewChannelDialog} from "@/components/NewChannelDialog";
import {BrowseChannelsDialog} from "@/components/BrowseChannelsDialog";
import {useAuth} from "@/context/AuthContext";
import {createDialogAtom, closeCreate} from "./createStore";

export function CreateDialogs() {
    const {user} = useAuth();
    const kind = useSelector(createDialogAtom);
    if (!user) return null;
    // The dialogs only signal close (onOpenChange(false)); clear the atom then.
    const onClose = (open: boolean) => {
        if (!open) closeCreate();
    };
    return (
        <>
            <NewDmDialog open={kind === "dm"} onOpenChange={onClose} />
            <NewDmDialog named open={kind === "chat"} onOpenChange={onClose} />
            <NewChannelDialog open={kind === "channel"} onOpenChange={onClose} />
            <BrowseChannelsDialog open={kind === "browse"} onOpenChange={onClose} />
        </>
    );
}
