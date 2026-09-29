import { useEffect, useRef, useState, type RefObject } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { isMacDesktop, openExternal } from "@/lib/desktop";
import { toast } from "@/lib/toast";

const Recognition =
  "SpeechRecognition" in window ? SpeechRecognition : "webkitSpeechRecognition" in window ? webkitSpeechRecognition : undefined;

/** The Mac app only: there WebKit serves the Web Speech API from Apple's recognizer. */
export const dictationSupported = isMacDesktop && Recognition !== undefined;

export interface DictationPrefs {
  /** Send the message once the speaker pauses for `delayMs`, then keep listening for the next one. */
  autoSend: boolean;
  delayMs: number;
}

export const DELAY_RANGE = { min: 1000, max: 5000, step: 500 };
const PREFS_KEY = "fc_dictation";
const DEFAULT_PREFS: DictationPrefs = { autoSend: true, delayMs: 1500 };

export function getDictationPrefs(): DictationPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<DictationPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function setDictationPrefs(prefs: DictationPrefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

const PRIVACY = "x-apple.systempreferences:com.apple.preference.security?";

/** What each failure says, and the System Settings pane that fixes it. */
const ERRORS: Partial<Record<SpeechRecognitionErrorCode, { title: string; pane?: string }>> = {
  "not-allowed": { title: "Microphone access is off for Clawbits", pane: "Privacy_Microphone" },
  "service-not-allowed": { title: "Speech recognition is off for Clawbits", pane: "Privacy_SpeechRecognition" },
  "audio-capture": { title: "No microphone found" },
  network: { title: "Dictation needs an internet connection" },
  "language-not-supported": { title: `Dictation doesn't support ${navigator.language}` },
};

/**
 * Dictation into a text field. Words land at the caret, replacing the selection,
 * as they are heard; `tentative` is the tail that may still change. `toggle`
 * starts, or stops keeping what was heard; `discard` stops and restores the text;
 * `abort` stops where it is. With auto-send, `onSilence` fires once words were
 * heard and none followed for the delay: the recognizer updates continuously
 * while someone speaks, so that gap is the pause, whatever the background noise.
 * `sent` then keeps listening for the next message, never showing the sent words
 * again, or stops when auto-send is off.
 */
export function useDictation(options: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  onDraft: (text: string, caret: number) => void;
  onSilence: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "starting" | "listening">("idle");
  const [countdown, setCountdown] = useState<{ at: number; ms: number } | null>(null);
  const [tentative, setTentative] = useState<{ start: number; end: number } | null>(null);
  const session = useRef<{ end: () => void; next: () => boolean; restore: () => void; stop: () => void } | null>(null);
  const latest = useLatestRef(options);

  const finish = () => {
    if (!session.current) return;
    session.current.end();
    session.current = null;
    setStatus("idle");
    setCountdown(null);
    setTentative(null);
  };

  const start = () => {
    const input = latest.current.inputRef.current;
    if (!Recognition || !input) return;
    const { autoSend, delayMs } = getDictationPrefs();
    const { draft } = latest.current;
    let before = draft.slice(0, input.selectionStart);
    let after = draft.slice(input.selectionEnd);
    let seen = 0;
    let consumed = 0;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language;
    const current = {
      end: () => {
        clearTimeout(silence);
        recognition.abort();
      },
      next: () => {
        if (!autoSend) return false;
        clearTimeout(silence);
        consumed = seen;
        before = after = "";
        setCountdown(null);
        setTentative(null);
        return true;
      },
      restore: () => { latest.current.onDraft(before + after, before.length); },
      stop: () => { recognition.stop(); },
    };
    session.current = current;
    input.focus();

    recognition.onstart = () => { setStatus("listening"); };
    recognition.onresult = (e) => {
      if (session.current !== current) return;
      seen = e.results.length;
      const settled: string[] = [];
      const pending: string[] = [];
      for (const result of Array.from(e.results).slice(consumed)) {
        const text = result.item(0).transcript.trim();
        if (text) (result.isFinal ? settled : pending).push(text);
      }
      const heard = [...settled, ...pending].join(" ");
      if (!heard) return;
      const lead = before && !/\s$/.test(before) ? " " : "";
      const caret = before.length + lead.length + heard.length;
      const tail = pending.join(" ").length;
      latest.current.onDraft(before + lead + heard + after, caret);
      setTentative(tail ? { start: caret - tail, end: caret } : null);
      if (!autoSend) return;
      clearTimeout(silence);
      silence = setTimeout(() => { latest.current.onSilence(); }, delayMs);
      setCountdown({ at: Date.now(), ms: delayMs });
    };
    recognition.onerror = (e) => {
      const error = ERRORS[e.error];
      if (!error) return;
      const { pane } = error;
      toast.error(error.title, pane ? { action: { label: "Open Settings", onClick: () => { void openExternal(PRIVACY + pane); } } } : undefined);
    };
    recognition.onend = () => {
      if (session.current === current) finish();
    };
    setStatus("starting");
    recognition.start();
  };

  useEffect(() => () => { session.current?.end(); }, []);

  return {
    status,
    countdown,
    tentative,
    abort: finish,
    toggle: () => {
      if (session.current) session.current.stop();
      else start();
    },
    discard: () => {
      session.current?.restore();
      finish();
    },
    sent: () => {
      if (!session.current?.next()) finish();
    },
  };
}
