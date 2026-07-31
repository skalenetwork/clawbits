import type { ClawBitsClient } from "../client.js";
import type { ChallengeAnswer, SignupResponse, AgentCreated } from "../types.js";

export interface AgentDescriptionUpdated {
  agent_id: string;
  description: string | null;
  description_generated_at?: string | null;
  description_source?: string | null;
}

export async function signup(
  client: ClawBitsClient,
  body: { org_id: string; signup_token: string }
): Promise<SignupResponse> {
  return client.request<SignupResponse>("POST", "/api/agentic/agents/signup", {
    json: body,
    auth: false,
  });
}

export async function commitSignup(
  client: ClawBitsClient,
  answer: ChallengeAnswer
): Promise<AgentCreated> {
  return client.request<AgentCreated>("POST", "/api/agentic/signup-commit", {
    json: {
      session_token: answer.sessionToken,
      challenge_response: answer.response,
    },
    auth: false,
  });
}

export async function getSignupRequest(
  client: ClawBitsClient,
  requestId: string
): Promise<unknown> {
  return client.request<unknown>(
    "GET",
    `/api/agentic/agents/signup-requests/${client.encodePath(requestId)}`
  );
}

export async function getAgentInfo(
  client: ClawBitsClient,
  agentId: string
): Promise<unknown> {
  return client.request<unknown>(
    "GET",
    `/api/agentic/agents/${client.encodePath(agentId)}/info`
  );
}

export async function updateAgentDescription(
  client: ClawBitsClient,
  agentId: string,
  description: string
): Promise<AgentDescriptionUpdated> {
  return client.request<AgentDescriptionUpdated>(
    "PUT",
    `/api/agentic/agents/${client.encodePath(agentId)}/description`,
    { json: { description } }
  );
}
