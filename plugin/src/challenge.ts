import { ClawBitsError } from "./errors.js";
import type { ClawBitsClient } from "./client.js";
import type { Challenge, ChallengeAnswer } from "./types.js";
import { BUNDLED_KNOWN_ANSWERS } from "./knownAnswers.js";

const DEFAULT_MAX_ATTEMPTS = 16;
const DEFAULT_DELAY_MS = 150;

export async function getChallenge(
  client: ClawBitsClient
): Promise<Challenge> {
  return client.request<Challenge>("GET", "/api/agentic/auth/challenge");
}

export function answerChallenge(
  challenge: Challenge,
  knownAnswers: Record<string, string>
): ChallengeAnswer {
  const answer = knownAnswers[challenge.challenge];
  if (answer === undefined) {
    throw new ClawBitsError({
      statusCode: 0,
      detail: "unknown challenge - ask the user",
      path: "/api/agentic/auth/challenge",
    });
  }
  return { sessionToken: challenge.session_token, response: answer };
}

export async function withChallenge<T>(
  client: ClawBitsClient,
  knownAnswers: Record<string, string>,
  fn: (answer: ChallengeAnswer) => Promise<T>,
  opts: { maxAttempts?: number; delayMs?: number } = {}
): Promise<T> {
  // Server samples challenges from a pool; retry until we land on one in
  // the known-answers dictionary.
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delay = opts.delayMs ?? DEFAULT_DELAY_MS;
  let lastUnknown: string | undefined;
  for (let i = 0; i < max; i++) {
    const challenge = await getChallenge(client);
    const ans = knownAnswers[challenge.challenge];
    if (ans !== undefined) {
      return fn({ sessionToken: challenge.session_token, response: ans });
    }
    lastUnknown = challenge.challenge;
    if (i < max - 1) await new Promise((r) => setTimeout(r, delay));
  }
  throw new ClawBitsError({
    statusCode: 0,
    detail: `challenge_unknown after ${max} attempts (last: ${lastUnknown ?? "n/a"})`,
    path: "/api/agentic/auth/challenge",
  });
}

export function resolveKnownAnswers(
  override?: Record<string, string>
): Record<string, string> {
  return override ? { ...BUNDLED_KNOWN_ANSWERS, ...override } : { ...BUNDLED_KNOWN_ANSWERS };
}
