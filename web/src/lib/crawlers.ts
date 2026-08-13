/**
 * The AI crawlers this site knows about, by name.
 *
 * ONE list, two consumers that must never disagree:
 *
 *   src/pages/robots.txt.ts - writes an explicit `Allow: /` per crawler. Every
 *     one of these is allowed, deliberately: Clawbits wants to be cited when
 *     someone asks an assistant how to give an agent its own chat identity.
 *   worker/index.ts - serves those same crawlers the demo-free variant of the
 *     homepage, because the hero mockup is ~69% of the page's bytes and ~66% of
 *     its extracted text, and all of that text is invented sample conversation.
 *
 * Split out of robots.txt.ts when the worker landed. Kept as a decision record
 * rather than a wildcard: naming each crawler makes it obvious which ones have
 * been considered, and lets a single one be treated differently later without
 * touching the rest.
 *
 * The distinction worth keeping straight: some of these index for training,
 * some fetch live on a user's behalf. Blocking the live fetchers (ChatGPT-User,
 * Claude-User, PerplexityBot) is what makes an assistant say "I can't read that
 * page", so those matter most - and they are also the ones the demo-free
 * variant helps most, since they read the page once and answer from it.
 */
export const AI_CRAWLERS = [
  // OpenAI: training index, live user fetch, and search.
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  // Anthropic: training index and live user fetch.
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  // Google: Gemini/Vertex grounding. Separate from Googlebot, which is covered
  // by robots.txt's wildcard and must never be blocked - or, see below, served
  // anything other than what a person gets.
  "Google-Extended",
  // Perplexity: index and live fetch.
  "PerplexityBot",
  "Perplexity-User",
  // Apple Intelligence / Siri grounding.
  "Applebot-Extended",
  // Meta, Amazon, Bytedance, Common Crawl.
  "meta-externalagent",
  "Amazonbot",
  "Bytespider",
  "CCBot",
] as const;

/**
 * Two of the names above - `Google-Extended` and `Applebot-Extended` - are
 * robots.txt CONTROL TOKENS, not user-agent strings any request actually
 * carries. Matching them below is a permanent no-op. They stay in the shared
 * list because robots.txt genuinely needs them and one list that is right for
 * both consumers beats two lists that drift.
 */

/**
 * Does this request come from a crawler that should get the demo-free page?
 *
 * SEARCH ENGINES ARE DELIBERATELY EXCLUDED. Googlebot and Bingbot are not on
 * this list and must never be added to it: serving a search crawler different
 * content than a person gets is cloaking, and the demo is not worth a manual
 * action. The list above is assistants and training crawlers only - surfaces
 * where a trimmed, honest page is what the convention asks for anyway (compare
 * /llms.txt, which exists for exactly this reason).
 *
 * Substring match, case-insensitive: real crawler UAs wrap their token in a
 * Mozilla/5.0 preamble and a contact URL, e.g.
 * `Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)`.
 *
 * An unknown or generic user agent - `curl`, `python-httpx`, an agent framework
 * that never says who it is - gets the full page. That is the safe default: a
 * person debugging with curl is indistinguishable from a robot, and being
 * wrong in this direction only costs bytes.
 */
export function isAiCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return AI_CRAWLERS.some((name) => ua.includes(name.toLowerCase()));
}
