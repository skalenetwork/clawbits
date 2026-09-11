import { useEffect, useState, type ReactNode } from "react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";

const LANG_LABELS = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  jsx: "JSX",
  tsx: "TSX",
  python: "Python",
  bash: "Bash",
  shell: "Shell",
  json: "JSON",
  yaml: "YAML",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  markdown: "Markdown",
  rust: "Rust",
  go: "Go",
  diff: "Diff",
} as const;

type SupportedLang = keyof typeof LANG_LABELS;

const LANG_ALIASES: Record<string, SupportedLang> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
};

function normalizeLang(raw: string | null): SupportedLang | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return lower in LANG_LABELS ? (lower as SupportedLang) : (LANG_ALIASES[lower] ?? null);
}

function labelFor(raw: string | null, lang: SupportedLang | null): string {
  if (lang) return LANG_LABELS[lang];
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Text";
}

// Fine-grained shiki core, so the bundle carries only these grammars and
// themes; the first code block of the session loads it.
type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;
let highlighterPromise: Promise<ShikiHighlighter> | null = null;
function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/oniguruma"),
    ]);
    return createHighlighterCore({
      themes: [import("@shikijs/themes/vitesse-light"), import("@shikijs/themes/vitesse-dark")],
      langs: [
        import("@shikijs/langs/javascript"),
        import("@shikijs/langs/typescript"),
        import("@shikijs/langs/jsx"),
        import("@shikijs/langs/tsx"),
        import("@shikijs/langs/python"),
        import("@shikijs/langs/bash"),
        import("@shikijs/langs/shellscript"),
        import("@shikijs/langs/json"),
        import("@shikijs/langs/yaml"),
        import("@shikijs/langs/sql"),
        import("@shikijs/langs/html"),
        import("@shikijs/langs/css"),
        import("@shikijs/langs/markdown"),
        import("@shikijs/langs/rust"),
        import("@shikijs/langs/go"),
        import("@shikijs/langs/diff"),
      ],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  })();
  return highlighterPromise;
}

// Once loaded, later blocks highlight synchronously on first paint.
let highlighterReady: ShikiHighlighter | null = null;
void getHighlighter().then((h) => { highlighterReady = h; });

/** Vitesse light recolored to crimson keywords, orange functions, plum
 *  numbers and ink punctuation; dark stays stock. */
const RECOLOR = {
  "vitesse-light": {
    "#ab5959": "#9d1f3f",
    "#1e754f": "#9d1f3f",
    "#59873a": "#c2551c",
    "#2f798a": "#8f2b78",
    "#999999": "#393a34",
  },
};

// defaultColor:false emits --shiki-light/--shiki-dark per token, switched by the .dark class in index.css.
const highlight = (h: ShikiHighlighter, code: string, lang: SupportedLang) =>
  h.codeToHtml(code, {
    lang,
    themes: { light: "vitesse-light", dark: "vitesse-dark" },
    defaultColor: false,
    colorReplacements: RECOLOR,
  });

export const CODE_BODY = "overflow-x-auto px-4 pb-3 font-mono text-[13px] leading-[1.7]";
const LINE_PX = 13 * 1.7;
const HEADER_PX = 32;
const PAD_BOTTOM_PX = 12;

// The plain <pre> and the highlighted html share metrics, so reserving the
// final height keeps the async highlight swap from shifting the chat.
function reservedHeight(code: string): number {
  const lines = code === "" ? 1 : code.split("\n").length;
  return Math.ceil(HEADER_PX + PAD_BOTTOM_PX + lines * LINE_PX);
}

export function CodeBlock({
  code,
  lang,
  bare = false,
}: {
  code: string;
  /** Raw language hint from the markdown fence (e.g. "ts", "python"). */
  lang: string | null;
  /** Just the highlighted code, no card chrome: the attachment viewer's reading surface. */
  bare?: boolean;
}) {
  const normalized = normalizeLang(lang);
  const [highlighter, setHighlighter] = useState(highlighterReady);
  const [copied, setCopied] = useState(false);
  const html = highlighter && normalized ? highlight(highlighter, code, normalized) : null;

  useEffect(() => {
    if (highlighter || !normalized) return;
    let cancelled = false;
    void getHighlighter().then((h) => {
      if (!cancelled) setHighlighter(h);
    });
    return () => {
      cancelled = true;
    };
  }, [highlighter, normalized]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 1600);
    } catch {
      // Clipboard blocked (insecure context or denied): the text stays selectable.
    }
  };

  if (bare) {
    return html ? (
      <div className="code-block-shiki font-mono text-[13px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <pre className="font-mono text-[13px] leading-relaxed whitespace-pre">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <CodeFrame
      lang={lang}
      minHeight={reservedHeight(code)}
      action={
    <button
      type="button"
      onClick={() => { void onCopy(); }}
      title={copied ? "Copied" : "Copy code"}
      aria-label={copied ? "Copied" : "Copy code"}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-foreground/[0.07] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none group-hover/code:opacity-100 max-md:opacity-100"
    >
      <Icon icon={copied ? Tick02Icon : Copy01Icon} className="size-3.5" />
    </button>
      }
    >
      {html ? (
        <div className={`code-block-shiki ${CODE_BODY}`} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className={CODE_BODY}>
          <code>{code}</code>
        </pre>
      )}
    </CodeFrame>
  );
}

/** The code surface and its language row, shared with the streaming tail so a settling block never shifts. */
export function CodeFrame({
  lang,
  action,
  minHeight,
  children,
}: {
  lang: string | null;
  action?: ReactNode;
  minHeight?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="code-block group/code relative my-2.5 overflow-hidden rounded-xl bg-code ring-1 ring-inset ring-code-border"
      style={minHeight ? { minHeight: `${String(minHeight)}px` } : undefined}
    >
      <div className="flex h-8 items-center justify-between pr-1.5 pl-4">
        <span className="code-block-lang select-none text-[11px] font-medium text-muted-foreground">
          {labelFor(lang, normalizeLang(lang))}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}
