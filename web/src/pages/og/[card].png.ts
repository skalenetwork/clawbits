import type { APIRoute } from "astro";
import { OG_CARDS, type OgCard } from "../../config";
import { renderOg } from "../../lib/og";

export function getStaticPaths() {
  return Object.keys(OG_CARDS).map((card) => ({ params: { card } }));
}

export const GET: APIRoute = async ({ params }) =>
  new Response(new Uint8Array(await renderOg(OG_CARDS[params.card as OgCard])), {
    headers: { "Content-Type": "image/png" },
  });
