/**
 * HugeIcons array -> inline SVG markup, at the app's own stroke weight.
 *
 * The product's Icon.tsx defaults to stroke-width 2 while the free-icon data
 * ships 1.5, so every glyph is re-stroked on the way out; "key" is a React-only
 * field and is dropped. Shared by every component that recreates app chrome
 * (AppDemo, MailboxVisual) so they cannot drift to different icon weights.
 */

type IconEl = readonly (readonly [string, Record<string, string>])[];

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

export const ico = (icon: unknown): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
  (icon as IconEl)
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .filter(([k]) => k !== "key")
          .map(([k, v]) => `${kebab(k)}="${k === "strokeWidth" ? "2" : v}"`)
          .join(" ")}/>`,
    )
    .join("") +
  `</svg>`;
