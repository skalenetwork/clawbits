#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(pluginRoot, "dist");
const targetArg = process.argv[2];
if (!targetArg) {
  console.error("usage: node stage-tools.mjs <target-dir>");
  process.exit(2);
}
if (!existsSync(resolve(distRoot, "tools-entry.js"))) {
  console.error("dist/tools-entry.js is missing; run the plugin build first");
  process.exit(1);
}

const targetRoot = isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg);
const targetDist = resolve(targetRoot, "dist");

// The target is wiped before staging, so refuse anything that isn't clearly a
// staging output: the plugin tree itself, the current directory, an ancestor
// of either, or an existing non-empty directory without a prior stage's
// openclaw.plugin.json marker.
function guardTarget() {
  const protectedRoots = [pluginRoot, process.cwd()];
  for (const root of protectedRoots) {
    if (targetRoot === root || root.startsWith(`${targetRoot}${sep}`)) {
      throw new Error(`refusing to stage into ${targetRoot}: it contains ${root}`);
    }
  }
  if (!existsSync(targetRoot)) return;
  if (!statSync(targetRoot).isDirectory()) {
    throw new Error(`refusing to replace non-directory target: ${targetRoot}`);
  }
  const entries = readdirSync(targetRoot);
  if (entries.length > 0 && !entries.includes("openclaw.plugin.json")) {
    throw new Error(
      `refusing to delete ${targetRoot}: existing directory does not look like a previous staging output`,
    );
  }
}

// Import scanning is text-based over tsc output (comments survive: tsc runs
// without removeComments). Lines that are only comment prose are dropped
// before scanning so a phrase like `// moved out of "./types.js"` can't be
// mistaken for an import; trailing comments on code lines still fail loud in
// resolveLocalImport rather than silently mis-staging.
function scannableSource(path) {
  return readFileSync(path, "utf8").replace(/^\s*(?:\/\/|\/?\*).*$/gmu, "");
}

// Matches relative static imports/re-exports, side-effect imports, and
// dynamic imports — including whitespace or a newline after `import(`, which
// tsc emits verbatim from source. Captures only `.`-prefixed specifiers, so
// prose like `from 'disk'` inside a code string can't join the graph.
const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/gu;
// Bare specifiers, scanned from line-anchored import/export statements only
// (tsc emits them at line starts); a mid-line bare dynamic import would slip
// past this check but still resolves via the peer at runtime.
const bareImportPattern =
  /^\s*(?:import\s+[^'"\n]*?\bfrom\s*|export\s+[^'"\n]*?\bfrom\s*|import\s*\(?\s*)['"]([^'".][^'"]*)['"]/gmu;
// Any dynamic import NOT followed by a string literal can't be resolved
// statically and would otherwise be dropped from the artifact silently.
const opaqueDynamicImportPattern = /\bimport\s*\(\s*(?!['"])[^)\s]/gu;

// Bare specifiers the staged artifact may legitimately leave external. Every
// non-node bare import must be declared in package.tools.json so the
// published package can't accumulate undeclared runtime dependencies.
const toolsPackage = JSON.parse(
  readFileSync(resolve(pluginRoot, "package.tools.json"), "utf8"),
);
const declaredExternalPackages = new Set([
  ...Object.keys(toolsPackage.dependencies ?? {}),
  ...Object.keys(toolsPackage.peerDependencies ?? {}),
]);

function packageRoot(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function checkBareSpecifier(importer, specifier) {
  if (specifier.startsWith("node:")) return;
  const root = packageRoot(specifier);
  if (!declaredExternalPackages.has(root)) {
    throw new Error(
      `undeclared external import in ${relative(distRoot, importer)}: '${specifier}' ` +
        `(add '${root}' to package.tools.json dependencies/peerDependencies or remove the import)`,
    );
  }
}

function insideDist(path) {
  const rel = relative(distRoot, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolveLocalImport(importer, specifier) {
  const candidate = resolve(dirname(importer), specifier);
  if (!insideDist(candidate)) {
    throw new Error(`local import escapes dist: ${relative(distRoot, importer)} -> ${specifier}`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`missing local import: ${relative(distRoot, importer)} -> ${specifier}`);
  }
  return candidate;
}

const visited = new Set();

function visit(path) {
  if (visited.has(path)) return;
  visited.add(path);
  const source = scannableSource(path);
  const opaque = source.match(opaqueDynamicImportPattern);
  if (opaque) {
    throw new Error(
      `unresolvable dynamic import in ${relative(distRoot, path)}: '${opaque[0]}…' — ` +
        `the staged artifact would silently miss its target`,
    );
  }
  for (const match of source.matchAll(bareImportPattern)) {
    checkBareSpecifier(path, match[1]);
  }
  for (const match of source.matchAll(importPattern)) {
    visit(resolveLocalImport(path, match[1]));
  }
}

// Declaration files import type-only modules (e.g. ./types.js) that the
// runtime graph never touches because tsc erases those imports from the .js
// output. Walk the .d.ts graph separately so the published `types` entry
// resolves; d.ts-only modules stage just their declaration.
const visitedDeclarations = new Set();

function visitDeclaration(path) {
  if (visitedDeclarations.has(path)) return;
  visitedDeclarations.add(path);
  const source = scannableSource(path);
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const candidate = resolve(dirname(path), specifier).replace(/\.js$/u, ".d.ts");
    if (!insideDist(candidate)) {
      throw new Error(
        `declaration import escapes dist: ${relative(distRoot, path)} -> ${specifier}`,
      );
    }
    if (!existsSync(candidate)) {
      throw new Error(
        `missing declaration for import: ${relative(distRoot, path)} -> ${specifier}`,
      );
    }
    visitDeclaration(candidate);
  }
}

visit(resolve(distRoot, "tools-entry.js"));
for (const source of [...visited]) {
  const declaration = source.replace(/\.js$/u, ".d.ts");
  if (existsSync(declaration)) visitDeclaration(declaration);
}

guardTarget();
rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetDist, { recursive: true });

const staged = [...new Set([...visited, ...visitedDeclarations])].sort();
for (const source of staged) {
  const destination = resolve(targetDist, relative(distRoot, source));
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

cpSync(resolve(pluginRoot, "package.tools.json"), resolve(targetRoot, "package.json"));
cpSync(
  resolve(pluginRoot, "openclaw.tools.plugin.json"),
  resolve(targetRoot, "openclaw.plugin.json"),
);
cpSync(resolve(pluginRoot, "README.tools.md"), resolve(targetRoot, "README.md"));
console.log(
  `staged ${visited.size} runtime modules (+${visitedDeclarations.size} declarations) in ${targetRoot}`,
);
