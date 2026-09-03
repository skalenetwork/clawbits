import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(pluginRoot, "dist");

function scannableSource(path) {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/gu;
const bareImportPattern =
  /^\s*(?:import\s+[^'"\n]*?\bfrom\s*|export\s+[^'"\n]*?\bfrom\s*|import\s*\(?\s*)['"]([^'".][^'"]*)['"]/gmu;
const opaqueDynamicImportPattern = /\bimport\s*\(\s*(?!['"])[^)\s]/gu;

function packageRoot(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

export function stageArtifact(options) {
  const {
    targetArg,
    entry,
    packageFile,
    manifestFile,
    readmeFile,
    extraDirectories = [],
    extraFiles = [],
    label,
    vendorDependencies = false,
  } = options;
  if (!targetArg) throw new Error(`usage: node stage-${label}.mjs <target-dir> [--vendor-deps]`);

  const entryPath = resolve(distRoot, entry);
  if (!existsSync(entryPath)) {
    throw new Error(`dist/${entry} is missing; run the plugin build first`);
  }
  const targetRoot = isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg);
  const targetDist = resolve(targetRoot, "dist");

  const protectedRoots = [pluginRoot, process.cwd()];
  for (const root of protectedRoots) {
    if (targetRoot === root || root.startsWith(`${targetRoot}${sep}`)) {
      throw new Error(`refusing to stage into ${targetRoot}: it contains ${root}`);
    }
  }
  if (existsSync(targetRoot)) {
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

  const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, packageFile), "utf8"));
  const declaredExternalPackages = new Set([
    "openclaw", // host-provided plugin SDK
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ]);

  function checkBareSpecifier(importer, specifier) {
    if (specifier.startsWith("node:")) return;
    const root = packageRoot(specifier);
    if (!declaredExternalPackages.has(root)) {
      throw new Error(
        `undeclared external import in ${relative(distRoot, importer)}: '${specifier}' ` +
          `(add '${root}' to ${packageFile} dependencies/peerDependencies or remove the import)`,
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
        `unresolvable dynamic import in ${relative(distRoot, path)}: '${opaque[0]}…'`,
      );
    }
    for (const match of source.matchAll(bareImportPattern)) {
      checkBareSpecifier(path, match[1]);
    }
    for (const match of source.matchAll(importPattern)) {
      visit(resolveLocalImport(path, match[1]));
    }
  }

  const visitedDeclarations = new Set();
  function visitDeclaration(path) {
    if (visitedDeclarations.has(path)) return;
    visitedDeclarations.add(path);
    const source = scannableSource(path);
    for (const match of source.matchAll(bareImportPattern)) {
      checkBareSpecifier(path, match[1]);
    }
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

  visit(entryPath);
  for (const source of [...visited]) {
    const declaration = source.replace(/\.js$/u, ".d.ts");
    if (existsSync(declaration)) visitDeclaration(declaration);
  }

  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetDist, { recursive: true });
  const staged = [...new Set([...visited, ...visitedDeclarations])].sort();
  for (const source of staged) {
    const destination = resolve(targetDist, relative(distRoot, source));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  cpSync(resolve(pluginRoot, packageFile), resolve(targetRoot, "package.json"));
  cpSync(resolve(pluginRoot, manifestFile), resolve(targetRoot, "openclaw.plugin.json"));
  if (readmeFile) cpSync(resolve(pluginRoot, readmeFile), resolve(targetRoot, "README.md"));
  for (const file of extraFiles) {
    cpSync(resolve(pluginRoot, file), resolve(targetRoot, file));
  }
  for (const directory of extraDirectories) {
    cpSync(resolve(pluginRoot, directory), resolve(targetRoot, directory), { recursive: true });
  }

  // Vendoring is opt-in because it is only correct for PATH installs. OpenClaw
  // runs `npm install` for managed npm/ClawHub sources (src/plugins/
  // install-managed-npm.ts) and relinks the host peer afterwards, so a
  // published artifact must let npm resolve normally. A directory install is a
  // plain copy with no dependency step at all, so a declared runtime dependency
  // that is not physically present makes the plugin fail to load — which is
  // exactly what happened to the tools package: `typebox` is imported at module
  // scope by companion-tools.ts, so the reef local image installed a plugin
  // whose status was `error: missing typebox` while the channel loaded fine.
  const vendored = [];
  if (vendorDependencies) {
    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      const source = resolve(pluginRoot, "node_modules", dependency);
      if (!existsSync(source)) {
        throw new Error(
          `cannot vendor '${dependency}': ${source} is missing (run the plugin's install first)`,
        );
      }
      const destination = resolve(targetRoot, "node_modules", dependency);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, dereference: true });
      vendored.push(dependency);
    }
  }

  console.log(
    `staged ${label}: ${visited.size} runtime modules (+${visitedDeclarations.size} declarations)` +
      `${vendored.length > 0 ? ` (+vendored ${vendored.join(", ")})` : ""} in ${targetRoot}`,
  );
}
