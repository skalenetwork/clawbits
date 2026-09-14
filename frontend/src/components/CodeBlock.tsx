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

// Fine-grained shiki core, so the bundle carries only these grammars and themes.
type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;
let highlighterPromise: Promise<ShikiHighlighter> | null = null;
let highlighterReady: ShikiHighlighter | null = null;
function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/oniguruma"),
    ]);
    highlighterReady = await createHighlighterCore({
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
    return highlighterReady;
  })();
  return highlighterPromise;
}

const RECOLOR = {
  "vitesse-light": {
    "#ab5959": "#9d1f3f",
    "#1e754f": "#9d1f3f",
    "#59873a": "#c2551c",
    "#2f798a": "#8f2b78",
    "#999999": "#393a34",
  },
};

export const CODE_BODY = "overflow-x-auto px-4 pb-3 font-mono text-[13px] leading-[1.7]";
const LINE_PX = 13 * 1.7;
const CHROME_PX = 32 + 12;

export function CodeBlock({ code, lang, bare = false }: { code: string; lang: string | null; bare?: boolean }) {
  const normalized = normalizeLang(lang);
  const [highlighter, setHighlighter] = useState(highlighterReady);
  const [copied, setCopied] = useState(false);
  // defaultColor:false emits --shiki-light/--shiki-dark per token, switched by the .dark class in index.css.
  const html = highlighter && normalized
    ? highlighter.codeToHtml(code, {
        lang: normalized,
        themes: { light: "vitesse-light", dark: "vitesse-dark" },
        defaultColor: false,
        colorReplacements: RECOLOR,
      })
    : null;

  useEffect(() => {
    if (!highlighter && normalized) void getHighlighter().then(setHighlighter);
  }, [highlighter, normalized]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1600);
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

  const copyLabel = copied ? "Copied" : "Copy code";
  return (
    <CodeFrame
      lang={lang}
      minHeight={Math.ceil(CHROME_PX + code.split("\n").length * LINE_PX)}
      action={
        <button
          type="button"
          onClick={() => { void onCopy(); }}
          title={copyLabel}
          aria-label={copyLabel}
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
  const normalized = normalizeLang(lang);
  return (
    <div
      className="group/code relative my-2.5 overflow-hidden rounded-xl bg-code ring-1 ring-inset ring-code-border"
      style={{ minHeight }}
    >
      <div className="flex h-8 items-center justify-between pr-1.5 pl-4">
        <span className="select-none text-[11px] font-medium text-muted-foreground">
          {normalized ? LANG_LABELS[normalized] : lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : "Text"}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}
