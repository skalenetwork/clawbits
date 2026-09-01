/**
 * Single source of truth for how a file is presented across the app:
 * which colored icon represents it, and whether/how it can be previewed
 * in-browser. Used by the composer attachment chips, in-message file
 * cards, the Attachments sidebar rows, and the universal AttachmentViewer
 * — so a ``.pdf`` looks (and previews) identically wherever it appears.
 *
 * Classification is by file extension first (more specific — a ``.csv``
 * served as ``text/plain`` should still read as a spreadsheet), falling
 * back to the MIME ``content_type`` prefix.
 */
import {
  Archive01Icon,
  Csv01Icon,
  Doc01Icon,
  File01Icon,
  FileAudioIcon,
  Image01Icon,
  Pdf01Icon,
  Ppt01Icon,
  SourceCodeIcon,
  Video01Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

export type FileCategory =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "archive"
  | "code"
  | "text"
  | "file";

export interface FileDescriptor {
  category: FileCategory;
  /** Short human label, e.g. "PDF", "Spreadsheet". */
  label: string;
  icon: IconSvgElement;
  /** Tailwind text-color class for the icon. */
  color: string;
  /** Tailwind background tint for an icon tile (matches ``color``). */
  tint: string;
}

const DESCRIPTORS: Record<FileCategory, Omit<FileDescriptor, "category">> = {
  image: { label: "Image", icon: Image01Icon, color: "text-teal-500", tint: "bg-teal-500/10" },
  video: { label: "Video", icon: Video01Icon, color: "text-indigo-500", tint: "bg-indigo-500/10" },
  audio: { label: "Audio", icon: FileAudioIcon, color: "text-pink-500", tint: "bg-pink-500/10" },
  pdf: { label: "PDF", icon: Pdf01Icon, color: "text-red-500", tint: "bg-red-500/10" },
  doc: { label: "Document", icon: Doc01Icon, color: "text-blue-500", tint: "bg-blue-500/10" },
  sheet: { label: "Spreadsheet", icon: Xls01Icon, color: "text-emerald-500", tint: "bg-emerald-500/10" },
  slides: { label: "Presentation", icon: Ppt01Icon, color: "text-orange-500", tint: "bg-orange-500/10" },
  archive: { label: "Archive", icon: Archive01Icon, color: "text-amber-500", tint: "bg-amber-500/10" },
  code: { label: "Code", icon: SourceCodeIcon, color: "text-violet-500", tint: "bg-violet-500/10" },
  text: { label: "Text", icon: File01Icon, color: "text-slate-500", tint: "bg-slate-500/10" },
  file: { label: "File", icon: File01Icon, color: "text-muted-foreground", tint: "bg-muted-foreground/10" },
};

// Extension → category. The CSV icon is swapped in below for the literal
// ``.csv`` extension; everything else in "sheet" uses the spreadsheet icon.
const EXT_CATEGORY: Record<string, FileCategory> = {
  // documents
  doc: "doc", docx: "doc", rtf: "doc", odt: "doc", pages: "doc",
  // spreadsheets
  xls: "sheet", xlsx: "sheet", csv: "sheet", tsv: "sheet", ods: "sheet", numbers: "sheet",
  // slides
  ppt: "slides", pptx: "slides", odp: "slides", key: "slides",
  // archives
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive", xz: "archive",
  // code & structured text
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code",
  py: "code", rb: "code", go: "code", rs: "code", java: "code", kt: "code", swift: "code",
  c: "code", h: "code", cpp: "code", cc: "code", hpp: "code", cs: "code", php: "code",
  sh: "code", bash: "code", zsh: "code", sql: "code", html: "code", htm: "code", css: "code",
  scss: "code", json: "code", jsonc: "code", yaml: "code", yml: "code", toml: "code", xml: "code", svg: "code",
  // plain text
  txt: "text", md: "text", markdown: "text", log: "text", text: "text", env: "text", ini: "text", conf: "text",
  // media (covered by mime too, but extension wins for odd content-types)
  pdf: "pdf",
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function categoryFor(filename: string, contentType: string): FileCategory {
  const ext = extensionOf(filename);
  // MIME prefixes win for true media so a ``.jpeg``/``.mov`` with no/odd
  // extension still classifies right; extension wins for documents/code.
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "pdf";
  if (ext && EXT_CATEGORY[ext]) return EXT_CATEGORY[ext];
  if (contentType.startsWith("text/")) return "text";
  return "file";
}

/** Resolve the colored icon + label for a file. */
export function fileDescriptor(filename: string, contentType: string): FileDescriptor {
  const category = categoryFor(filename, contentType);
  const base = DESCRIPTORS[category];
  // Spreadsheet sub-case: a literal .csv reads better with the CSV glyph.
  if (category === "sheet" && extensionOf(filename) === "csv") {
    return { category, ...base, icon: Csv01Icon };
  }
  return { category, ...base };
}

// ---------------------------------------------------------------------------
// In-browser preview routing
// ---------------------------------------------------------------------------

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "none";

/** Max bytes we'll fetch to render an inline text/code preview. Larger
 *  files fall back to download — Shiki tokenizing megabytes would jank. */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

// Extensions that are safe + useful to render as highlighted *source* text.
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "text", "env", "ini", "conf", "csv", "tsv",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cpp", "cc", "hpp", "cs", "php", "sh", "bash", "zsh", "sql",
  "html", "htm", "css", "scss", "json", "jsonc", "yaml", "yml", "toml", "xml", "svg",
]);

/**
 * How a file should be previewed in the viewer.
 *
 * Security: raster images / video / audio render live; ``text/html`` and
 * ``image/svg+xml`` are deliberately routed to ``"text"`` (highlighted
 * *source*, never executed) rather than being framed against their R2
 * URL — both pass the upload allowlist and would otherwise be a stored-XSS
 * vector. PDFs are rendered from a typed blob we control, not the raw URL.
 */
export function previewKind(filename: string, contentType: string): PreviewKind {
  const ext = extensionOf(filename);
  // SVG + HTML: show source, don't execute. (Their extensions are in
  // TEXT_EXTS below; this catches a file that carries only the MIME.)
  if (contentType === "image/svg+xml" || contentType === "text/html") return "text";
  // A known source extension outranks the MIME the uploader's OS guessed:
  // ``.ts`` is TypeScript, not the MPEG transport stream ``video/mp2t``.
  if (TEXT_EXTS.has(ext)) return "text";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf" || ext === "pdf") return "pdf";
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/javascript" ||
    contentType === "application/x-yaml" ||
    TEXT_EXTS.has(ext)
  ) {
    return "text";
  }
  return "none";
}

/** Markdown source. Previews as ``"text"`` like any other source file, but
 *  the viewer additionally offers a rendered reading mode for it. */
export function isMarkdown(filename: string, contentType: string): boolean {
  const ext = extensionOf(filename);
  return ext === "md" || ext === "markdown" || contentType === "text/markdown";
}

/** Does this file have an in-browser preview at all (vs download-only)? */
export function isInlinePreviewable(filename: string, contentType: string): boolean {
  return previewKind(filename, contentType) !== "none";
}

// Extension → CodeBlock language hint (CodeBlock normalizes + aliases and
// falls back to a plain <pre> for anything it doesn't know).
const EXT_LANG: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", jsx: "jsx",
  py: "python", rs: "rust", go: "go", sql: "sql",
  sh: "bash", bash: "bash", zsh: "bash",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml",
  html: "html", htm: "html", svg: "html", xml: "html",
  css: "css", scss: "css",
  md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff",
};

/** Best-effort language hint for syntax-highlighting a text preview. */
export function languageForFile(filename: string): string | null {
  return EXT_LANG[extensionOf(filename)] ?? null;
}
