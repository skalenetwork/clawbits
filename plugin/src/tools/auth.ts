import type { ClawBitsClient } from "../client.js";
import type { ChallengeAnswer, Challenge } from "../types.js";

export async function getChallenge(
  client: ClawBitsClient
): Promise<Challenge> {
  return client.request<Challenge>("GET", "/api/agentic/auth/challenge");
}

export async function postResponse(
  client: ClawBitsClient,
  body: { session_token: string; response: string }
): Promise<unknown> {
  return client.request<unknown>("POST", "/api/agentic/auth/challenge_response", {
    json: {
      session_token: body.session_token,
      challenge_response: body.response,
    },
  });
}

export async function rotateKey(
  client: ClawBitsClient,
  answer: ChallengeAnswer
): Promise<unknown> {
  return client.request<unknown>("POST", "/api/agentic/auth/rotate-key", {
    challenge: answer,
  });
}

export async function commitRotateKey(
  client: ClawBitsClient,
  answer: ChallengeAnswer,
  body: unknown
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    "/api/agentic/auth/rotate-key/commit",
    { json: body, challenge: answer }
  );
}
