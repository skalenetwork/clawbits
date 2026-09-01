import { describe, expect, it } from "vitest";
import { Csv01Icon, Image01Icon } from "@hugeicons/core-free-icons";

import {
  fileDescriptor,
  isInlinePreviewable,
  languageForFile,
  previewKind,
} from "./fileTypes";

describe("fileDescriptor", () => {
  it("classifies by extension for documents/code/archives", () => {
    expect(fileDescriptor("report.pdf", "application/pdf").category).toBe("pdf");
    expect(fileDescriptor("notes.docx", "application/octet-stream").category).toBe("doc");
    expect(fileDescriptor("data.xlsx", "application/octet-stream").category).toBe("sheet");
    expect(fileDescriptor("main.ts", "text/plain").category).toBe("code");
    expect(fileDescriptor("bundle.zip", "application/zip").category).toBe("archive");
    expect(fileDescriptor("readme.md", "text/markdown").category).toBe("text");
  });

  it("lets true media MIME prefixes win over a missing extension", () => {
    const d = fileDescriptor("IMG_0001", "image/jpeg");
    expect(d.category).toBe("image");
    expect(d.icon).toBe(Image01Icon);
  });

  it("uses the CSV glyph for .csv but keeps the spreadsheet category", () => {
    const d = fileDescriptor("export.csv", "text/csv");
    expect(d.category).toBe("sheet");
    expect(d.icon).toBe(Csv01Icon);
  });

  it("falls back to the generic file descriptor for unknown types", () => {
    const d = fileDescriptor("mystery.bin", "application/octet-stream");
    expect(d.category).toBe("file");
    expect(d.color).toBe("text-muted-foreground");
  });

  it("returns a tailwind color + tint for every descriptor", () => {
    const d = fileDescriptor("report.pdf", "application/pdf");
    expect(d.color).toMatch(/^text-/);
    expect(d.tint).toMatch(/^bg-/);
  });
});

describe("previewKind", () => {
  it("renders raster media inline", () => {
    expect(previewKind("a.png", "image/png")).toBe("image");
    expect(previewKind("a.mp4", "video/mp4")).toBe("video");
    expect(previewKind("a.mp3", "audio/mpeg")).toBe("audio");
    expect(previewKind("a.pdf", "application/pdf")).toBe("pdf");
  });

  it("routes html and svg to source text, never live render (XSS guard)", () => {
    expect(previewKind("page.html", "text/html")).toBe("text");
    expect(previewKind("logo.svg", "image/svg+xml")).toBe("text");
  });

  it("previews text/code/structured formats as text", () => {
    expect(previewKind("a.txt", "text/plain")).toBe("text");
    expect(previewKind("a.json", "application/json")).toBe("text");
    expect(previewKind("a.ts", "application/octet-stream")).toBe("text");
  });

  it("lets a source extension outrank a media MIME the OS guessed", () => {
    expect(previewKind("a.ts", "video/mp2t")).toBe("text");
  });

  it("has no preview for opaque binaries / archives", () => {
    expect(previewKind("a.zip", "application/zip")).toBe("none");
    expect(previewKind("a.bin", "application/octet-stream")).toBe("none");
    expect(isInlinePreviewable("a.zip", "application/zip")).toBe(false);
    expect(isInlinePreviewable("a.png", "image/png")).toBe(true);
  });
});

describe("languageForFile", () => {
  it("maps known extensions to a CodeBlock language", () => {
    expect(languageForFile("a.ts")).toBe("typescript");
    expect(languageForFile("a.json")).toBe("json");
    expect(languageForFile("a.svg")).toBe("html");
    expect(languageForFile("a.py")).toBe("python");
  });

  it("returns null for unknown/plain extensions (plain-text fallback)", () => {
    expect(languageForFile("a.txt")).toBeNull();
    expect(languageForFile("noext")).toBeNull();
  });
});
