/**
 * lucide or HugeIcons node array -> inline SVG markup, drawn like the app.
 *
 * The root carries lucide-react's default stroke attributes, since lucide nodes
 * have none. HugeIcons carry their own per-element strokeWidth 1.5, re-stroked
 * to 2 because the product's Icon.tsx defaults both libraries to 2
 * (frontend/src/components/Icon.tsx:7); "key" is React-only and dropped.
 * Shared by every component that recreates app chrome (the hero demo,
 * MailboxVisual) so icon weights cannot drift.
 */

type IconNode = readonly (readonly [string, Readonly<Record<string, string | number | undefined>>])[];

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

export const ico = (icon: IconNode): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  icon
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .filter(([k]) => k !== "key")
          .map(([k, v]) => `${kebab(k)}="${k === "strokeWidth" ? "2" : v}"`)
          .join(" ")}/>`,
    )
    .join("") +
  `</svg>`;
