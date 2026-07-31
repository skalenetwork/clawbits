import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Copy01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";

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

function normalizeLang(raw: string | null): SupportedLang | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if ((LANGS as readonly string[]).includes(lower)) return lower as SupportedLang;
  return LANG_ALIASES[lower] ?? null;
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
      themes: [
        import("@shikijs/themes/github-light"),
        import("@shikijs/themes/github-dark"),
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
//   header + verticalPadding + lineCount × lineHeight + borders.
// Locking `min-height` to this value means the async shiki swap (if it
// happens at all — see `highlighterReady` above) changes only token
// colors, never the row height. Constants match the className below:
// `text-[0.875em]` of a 15px parent = ~13.125px, `leading-relaxed` =
// 1.625, so each rendered line is ~21.33px. Header is `pt-2` (8px) + the
// ~16px label/button row → 24px. Body padding is `pt-1.5` + `pb-3` = 18px.
// The card outline is now an inset `ring` (box-shadow), which adds no layout
// height, so the border term is 0.
const CODE_LINE_HEIGHT_PX = 21.33;
const CODE_HEADER_PX = 24;
const CODE_PADDING_Y_PX = 18;
const CODE_BORDER_PX = 0;

function reservedCodeHeight(code: string): number {
  // ``\n``-terminated buffers count an extra empty line — the wrapper
  // strips the trailing newline before passing here so this is the
  // visible line count.
  const lines = code.length === 0 ? 1 : code.split("\n").length;
  return Math.ceil(
    CODE_HEADER_PX + CODE_PADDING_Y_PX + lines * CODE_LINE_HEIGHT_PX + CODE_BORDER_PX,
  );
}

export function CodeBlock({ code, lang, bare = false }: CodeBlockProps) {
  const normalized = normalizeLang(lang);
  const displayLang = lang ?? "text";
  // Try sync render via the warm-cache highlighter. After the first
  // code block in a session, every subsequent one renders highlighted
  // HTML on first paint — no swap, no shift.
  const initialHtml = normalized && highlighterReady
    ? highlighterReady.codeToHtml(code, {
        lang: normalized,
        themes: { light: "github-light", dark: "github-dark" },
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
        themes: { light: "github-light", dark: "github-dark" },
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
      window.setTimeout(() => { setCopied(false); }, 1500);
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

  return (
    <div
      className="code-block group relative my-2 overflow-hidden rounded-xl bg-muted/40 ring-1 ring-inset ring-border/50 dark:bg-white/[0.04]"
      style={{ minHeight: `${String(minHeightPx)}px` }}
    >
      <div className="flex items-center justify-between gap-2 px-3.5 pt-2">
        <span className="font-mono text-[10px] lowercase tracking-wider text-muted-foreground/50">
          {displayLang}
        </span>
        <button
          type="button"
          onClick={() => { void onCopy(); }}
          className="flex items-center gap-1 rounded text-[11px] text-muted-foreground/70 opacity-70 transition-[color,opacity] duration-150 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          <Icon
            icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
            className="size-3"
          />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html ? (
        <div
          className="code-block-shiki overflow-x-auto px-3.5 pb-3 pt-1.5 font-mono text-[0.875em] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto px-3.5 pb-3 pt-1.5 font-mono text-[0.875em] leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
