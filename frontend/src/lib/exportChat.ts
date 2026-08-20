import {exportMmChannel} from "@/lib/api";
import {filenameFromDisposition, saveBlob} from "@/lib/download";
import {errMsg, toast} from "@/lib/toast";

/**
 * Download one conversation's archive, with the loading→result toast.
 *
 * Exporting walks the whole channel server-side, so a long history can take a
 * few seconds with nothing on screen to show for it; the loading toast is
 * replaced in place by the outcome rather than stacking a second one.
 *
 * **Rethrows on failure.** Callers that only fire-and-forget can ignore the
 * rejection (the toast already told the user), but the ones offering this
 * beside a destructive confirm must be able to tell a saved copy from a failed
 * one — swallowing the error here would let those dialogs report success over
 * a download that never landed.
 */
export async function exportChatToDisk(channelId: string): Promise<void> {
    const toastId = toast.loading("Preparing export…");
    try {
        const {blob, disposition} = await exportMmChannel(channelId);
        saveBlob(
            blob,
            filenameFromDisposition(disposition, `clawbits-${channelId}.json`),
        );
        toast.success("Chat exported", {id: toastId});
    } catch (err) {
        toast.error(errMsg(err, "Couldn't export chat"), {id: toastId});
        throw err;
    }
}
