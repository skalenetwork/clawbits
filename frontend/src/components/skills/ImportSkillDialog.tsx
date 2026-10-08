import {useRef, useState} from "react";
import {useMutation} from "@tanstack/react-query";
import {ModalButton, ModalField, ModalFooter, ModalHeader, ModalPanel} from "@/components/modals/Modal";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {useAuth} from "@/context/AuthContext";
import {importSkillDraft, type SkillDraft} from "@/lib/api";

/** Read a skill from a public GitHub link, a SKILL.md, a zip or a folder into
 *  an unsaved draft. Nothing is stored until the draft is created. */
export function ImportSkillDialog({open, onOpenChange, onDraft}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDraft: (draft: SkillDraft) => void;
}) {
    return (
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="form">
            <ModalHeader
                title="Import a skill"
                description="Read a skill from a public GitHub link or from files on this device, then review it before it's saved."
            />
            <ImportForm onClose={() => { onOpenChange(false); }} onDraft={onDraft}/>
        </ModalPanel>
    );
}

function ImportForm({onClose, onDraft}: {onClose: () => void; onDraft: (draft: SkillDraft) => void}) {
    const {activeOrgId} = useAuth();
    const [url, setUrl] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);

    const read = useMutation({
        mutationFn: (input: {url: string} | {files: File[]}) => importSkillDraft(activeOrgId ?? "", input),
        onSuccess: onDraft,
    });

    const pick = (folder: boolean) => {
        const input = fileRef.current!;
        input.webkitdirectory = folder;
        input.accept = folder ? "" : ".md,.zip";
        input.click();
    };

    const trimmed = url.trim();
    const busy = read.isPending;

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                if (trimmed) read.mutate({url: trimmed});
            }}
        >
            <div className="flex flex-col gap-4 p-4">
                <ModalField label="GitHub link" htmlFor="skill-import-url">
                    <Input
                        id="skill-import-url"
                        autoFocus
                        value={url}
                        onChange={(e) => { setUrl(e.target.value); }}
                        placeholder="https://github.com/owner/repo/tree/main/my-skill"
                        disabled={busy}
                    />
                </ModalField>
                <ModalField label="Or upload from this device">
                    <div className="flex gap-2">
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { pick(false); }}>
                            SKILL.md or zip
                        </Button>
                        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { pick(true); }}>
                            Folder
                        </Button>
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        hidden
                        onChange={(e) => {
                            const files = Array.from(e.target.files ?? []);
                            e.target.value = "";
                            if (files.length > 0) read.mutate({files});
                        }}
                    />
                </ModalField>
                <p className="text-[12px] text-muted-foreground">
                    Skills are text only, so only SKILL.md and references/ come in. You check the skill and what was left out before it's saved.
                </p>
            </div>
            <ModalFooter>
                <ModalButton onClick={onClose} disabled={busy}>Cancel</ModalButton>
                <ModalButton type="submit" tone="primary" disabled={!trimmed || busy}>
                    {busy ? "Importing…" : "Import"}
                </ModalButton>
            </ModalFooter>
        </form>
    );
}
