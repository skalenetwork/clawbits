import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";

// Languages we want highlighting for. Keep the set tight — each one is a
// few KB of grammar. Add more here as new use cases come up.
const LANGS = [
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "bash",
  "shell",
  "json",
  "yaml",
  "sql",
  "html",
  "css",
  "markdown",
  "rust",
  "go",
  "diff",
] as const;

type SupportedLang = (typeof LANGS)[number];

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

/** Pretty header labels. Falls back to the raw fence token title-cased, so an
 *  unknown language still reads as a deliberate label rather than raw input. */
const LANG_LABELS: Record<string, string> = {
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
};

function normalizeLang(raw: string | null): SupportedLang | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if ((LANGS as readonly string[]).includes(lower)) return lower as SupportedLang;
  return LANG_ALIASES[lower] ?? null;
}

function labelFor(raw: string | null, normalized: SupportedLang | null): string {
  if (normalized) return LANG_LABELS[normalized] ?? normalized;
  if (!raw) return "Text";
  // Unknown fence token: title-case it rather than shouting the raw string.
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Lazy-loaded singleton highlighter. Uses shiki's fine-grained core API
// so the bundler only emits the grammars and themes we actually use —
// not the full ~80-language bundle that ``import("shiki")`` pulls in.
// The first code block in the session triggers the load; subsequent
// blocks reuse the same highlighter.
type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;
let highlighterPromise: Promise<ShikiHighlighter> | null = null;
function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/oniguruma"),
    ]);
    return createHighlighterCore({
      // Vitesse rather than GitHub: its palette is warm and low-saturation
      // (terracotta strings, moss keywords), which sits inside this app's
      // cream/rust theme instead of dropping a cold blue IDE box into it.
      themes: [
        import("@shikijs/themes/vitesse-light"),
        import("@shikijs/themes/vitesse-dark"),
      ],
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

const SHIKI_THEMES = { light: "vitesse-light", dark: "vitesse-dark" } as const;

interface CodeBlockProps {
  code: string;
  /** Raw language hint from the markdown fence (e.g. "ts", "python"). */
  lang: string | null;
  /** Render with no surrounding card chrome (border, header bar, copy
   *  button, min-height) — just the highlighted code, filling its
   *  container. Used by the immersive attachment viewer so the preview
   *  reads as one surface rather than a box-in-a-box. */
  bare?: boolean;
}

// Cached highlighter ref. Once the singleton resolves, subsequent blocks
// can render highlighted HTML synchronously on first paint — no `<pre>`
// → tokenized swap, no late layout shift. Stays null until the first
// async load finishes; after that, every block in the session is sync.
let highlighterReady: ShikiHighlighter | null = null;
void getHighlighter().then((h) => { highlighterReady = h; });

// Code-block reserved box height (in px). The fallback `<pre>` and the
// shiki-rendered `<div>` both render at the same font-size/line-height
// with `overflow-x-auto` (no wrap), so the box is exactly:
//   header + verticalPadding + lineCount × lineHeight.
// Locking `min-height` to this value means the async shiki swap (if it
// happens at all — see `highlighterReady` above) changes only token
// colors, never the row height. Constants match the className below:
// code is `text-[12.5px]` with `leading-[1.7]` → 21.25px per line. The
// header is `h-8` (32px) plus its 1px bottom hairline. Body padding is
// `py-3` = 24px. The card outline is an inset `ring` (box-shadow), which
// adds no layout height.
const CODE_LINE_HEIGHT_PX = 21.25;
const CODE_HEADER_PX = 33;
const CODE_PADDING_Y_PX = 24;

function reservedCodeHeight(code: string): number {
  // ``\n``-terminated buffers count an extra empty line — the wrapper
  // strips the trailing newline before passing here so this is the
  // visible line count.
  const lines = code.length === 0 ? 1 : code.split("\n").length;
  return Math.ceil(CODE_HEADER_PX + CODE_PADDING_Y_PX + lines * CODE_LINE_HEIGHT_PX);
}

export function CodeBlock({ code, lang, bare = false }: CodeBlockProps) {
  const normalized = normalizeLang(lang);
  // Try sync render via the warm-cache highlighter. After the first
  // code block in a session, every subsequent one renders highlighted
  // HTML on first paint — no swap, no shift.
  const initialHtml = normalized && highlighterReady
    ? highlighterReady.codeToHtml(code, {
        lang: normalized,
        themes: SHIKI_THEMES,
        defaultColor: false,
      })
    : null;
  const [html, setHtml] = useState<string | null>(initialHtml);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!normalized) {
      // Unknown language — keep the plain-text fallback. No need to load
      // the highlighter at all for this block.
      setHtml(null);
      return;
    }
    // Sync path already populated `html` from the warm cache.
    if (highlighterReady) return;
    let cancelled = false;
    void getHighlighter().then((h) => {
      if (cancelled) return;
      const out = h.codeToHtml(code, {
        lang: normalized,
        themes: SHIKI_THEMES,
        // defaultColor:false emits CSS vars (--shiki-light / --shiki-dark)
        // per token, so the page's existing class-based dark switch
        // (html.dark) toggles colors with zero extra JS.
        defaultColor: false,
      });
      setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [code, normalized]);

  // Min-height is the computed box height. The fallback `<pre>` already
  // matches this naturally (no wrap, same font), so applying it costs
  // nothing on the fallback path — but it guarantees the box height is
  // committed at first paint even before shiki resolves.
  const minHeightPx = reservedCodeHeight(code);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 1600);
    } catch {
      // Clipboard may be blocked (insecure context, denied permission) —
      // silent failure is fine here; the user can still select+copy.
    }
  };

  // Bare variant — no card chrome, just the highlighted code filling the
  // container. The immersive attachment viewer wraps this in its own
  // padded, full-height reading surface.
  if (bare) {
    return html ? (
      <div
        className="code-block-shiki font-mono text-[13px] leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    ) : (
      <pre className="font-mono text-[13px] leading-relaxed whitespace-pre">
        <code>{code}</code>
      </pre>
    );
  }

  // Body classes are shared by the highlighted and plain-text paths so the
  // two render at identical metrics (see `reservedCodeHeight`).
  const bodyCls =
    "overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.7]";

  return (
    <div
      className="code-block group/code relative my-2.5 overflow-hidden rounded-xl bg-code ring-1 ring-inset ring-code-border"
      style={{ minHeight: `${String(minHeightPx)}px` }}
    >
      {/* Header rail: language on the left, copy on the right. The hairline
          under it is what makes the block read as a panel rather than a tinted
          paragraph — the single biggest cue that this is code. */}
      <div className="code-block-header flex h-8 items-center justify-between gap-2 border-b border-code-border bg-code-header pl-3.5 pr-1.5">
        <span className="code-block-lang select-none font-mono text-[11px] font-medium tracking-wide text-muted-foreground/70">
          {labelFor(lang, normalized)}
        </span>
        <button
          type="button"
          onClick={() => { void onCopy(); }}
          title={copied ? "Copied" : "Copy code"}
          aria-label={copied ? "Copied" : "Copy code"}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-[color,opacity,background-color] duration-150 hover:bg-foreground/[0.07] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none group-hover/code:opacity-100 max-[767px]:opacity-100"
        >
          <Icon
            icon={copied ? Tick02Icon : Copy01Icon}
            className={copied ? "size-3.5 text-foreground" : "size-3.5"}
          />
        </button>
      </div>
      {html ? (
        <div
          className={`code-block-shiki ${bodyCls}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={bodyCls}>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
