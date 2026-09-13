import {
  ModalButton,
  ModalFooter,
  ModalHeader,
  ModalPanel,
} from "@/components/modals/Modal";
import { ReleaseNotesBody } from "@/components/release-notes/ReleaseNotesBody";
import { useReleaseNotes } from "@/hooks/useReleaseNotes";
import { LATEST_RELEASE } from "@/lib/releaseNotes";

export function ReleaseNotesDialog() {
  const { open, dismiss } = useReleaseNotes();
  if (!LATEST_RELEASE) return null;
  const { version, title, body, image } = LATEST_RELEASE;
  const whatsNew = `What's new in v${version}`;

  return (
    <ModalPanel open={open} onOpenChange={next => { if (!next) dismiss(); }} kind="reader">
      <ModalHeader title={title ?? whatsNew} subtitle={title ? whatsNew : undefined} />

      <div className="space-y-3 px-4 pb-4">
        {image && (
          // object-right: the heroes are app captures whose subject sits right of an empty background.
          <img
            src={image}
            alt=""
            draggable={false}
            className="aspect-[2/1] w-full select-none rounded-xl object-cover object-right"
          />
        )}
        <ReleaseNotesBody content={body} className="text-[14px]/relaxed" />
      </div>

      <ModalFooter>
        <ModalButton to="/changelog" onClick={dismiss}>
          All updates
        </ModalButton>
        <ModalButton tone="primary" onClick={dismiss}>Got it</ModalButton>
      </ModalFooter>
    </ModalPanel>
  );
}
