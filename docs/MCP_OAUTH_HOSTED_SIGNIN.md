# Hosted MCP sign-in for clawbits agents

Handoff from the AgentPit session, 2026-09-24. This file explains the problem, the target, and the facts verified so far. The design choice and every clawbits-internal detail are yours: you know the runtime, reef, the plugin and the chat far better than this document does. Confirm the design with Dmytro before building.

## 1. Problem

AgentPit (paper-trading exchange for AI agents) onboards an agent with one sentence: "Read https://pit.clawbits.ai/skill.md and follow it to join AgentPit." The agent adds the remote MCP server `https://api.agentpit.dev/mcp` with OAuth, sends its human one sign-in link, and the runner keeps the token. The authorization server is WorkOS AuthKit (`https://supportive-banquet-05.authkit.app`).

Tested on 2026-09-24:

- **Grok Bot: seamless.** Grok registers a callback on its own domain. After sign-in the browser lands on Grok's page, "Authorization complete! You can close this tab. Return to Grok Bot", and the agent has the tools.
- **clawbits agent "Unbound" (hosted OpenClaw): broken UX.** OpenClaw registered `redirect_uri=http://127.0.0.1:8989/oauth/callback`. That is the container's loopback, so the human's browser landed on a dead localhost page. They had to copy the `code` out of the address bar into the chat, and the agent finished with `openclaw mcp login agentpit --code <code>`. The clawbits chat already rendered the link as a "Sign in" button; only the return trip failed.

Nothing here is specific to AgentPit. Every OAuth MCP server (Linear, Notion, GitHub, anything) hits the same dead page from a clawbits-hosted agent. The fix belongs in clawbits, as the host, the same way Grok solved it for Grok Bot.

## 2. Target

From a hosted clawbits agent, with no terminal and no copy-paste:

1. The agent adds an OAuth MCP server (itself, following a skill, or on request).
2. The chat shows the sign-in link or button.
3. The human signs in with the provider and lands on a clawbits page: "Connected. Return to the chat." (or straight back into the chat).
4. On its next turn the agent has the server's tools and says so.

Must work for any OAuth MCP server, OpenClaw first, then Hermes. Tokens survive container restarts and image upgrades.

## 3. Verified facts

Sources were read at pinned commits on 2026-09-24. Paths are relative to each repo.

### OpenClaw

Source: openclaw/openclaw `74b00d7`, release 2026.9.6. MCP TypeScript SDK 1.30.0.

**Config.** Per-server OAuth settings live under `mcp.servers.<name>.oauth` (`src/config/zod-schema.mcp-server.ts`):
- `redirectUrl`: any http(s) URL.
- `scope`.
- `clientMetadataUrl`: https, non-root path; enables CIMD.
- `identity`: `"shared" | "per-requester"`.
- `authProfileId`.

The CLI sets the redirect through `openclaw mcp add|configure <name> --oauth-redirect-url <url>`, or through `openclaw mcp set <name> '<json>'`.

**Default flow (shared identity).**
- The default redirect is `http://127.0.0.1:8989/oauth/callback` (`src/agents/mcp-oauth-store.mutations.ts:4`).
- `openclaw mcp login <name>` prints the authorize URL. It binds a loopback listener for 5 minutes, only when the redirect is http on localhost, 127.0.0.1 or ::1.
- With any other redirect it prints "After approval, run openclaw mcp login <name> --code <code>" and exits (`src/cli/mcp-cli.ts`, `src/infra/oauth-loopback-callback.ts`).

**`--code`.**
- Takes the bare code only. `state` is not checked, and a pasted full URL fails.
- The PKCE verifier and redirect are stored in `<state-dir>/state/openclaw.sqlite`, table `mcp_oauth_stores`.
- Running login again without `--code` overwrites the verifier, so an older code then fails.
- Showing the code on a page is safe: it is useless without that verifier.

**Registration.**
- DCR by default against WorkOS: `client_name "OpenClaw MCP"`, `grant_types [authorization_code, refresh_token]`, `token_endpoint_auth_method none`.
- CIMD only when `clientMetadataUrl` is set.
- A stored DCR client is reused. Changing the redirect needs `openclaw mcp logout <name>` first.

**Per-requester mode** (shipped 2026.8.1, #115921, #122166). This is OpenClaw's own hosted callback.
- It needs `oauth.identity: "per-requester"` plus `gateway.publicOrigin`, which must be https (http only for literal loopback).
- The callback is `<publicOrigin>/oauth/mcp/callback`.
- The chat sender gets a single-use sign-in link in chat. The callback page says "You're connected." / "Return to the chat." (`src/gateway/mcp-oauth-callback.ts`).
- `mcp login` refuses per-requester servers.
- Docs: `docs/cli/mcp/transports.md` (around lines 97-134) and `docs/gateway/config-gateway.md` (around lines 130-134).

**Control UI "Sign in"** (2026.9.6). Works only through the gateway's loopback or published Tailscale address. The redirect is `<origin>/oauth/provider/callback`.

**Not available.**
- Device flow for MCP.
- Token import: #124906 was closed as not planned.

**Open issues worth knowing.**
- #142333 (P1): a valid token is rejected at agent-turn startup. Candidate fix: PR #150296.
- #156170: `agent exec` cannot use the MCP OAuth store beside a running gateway.
- #122947: leftover pending attempts.
- #123605: `--code` InvalidGrant on a headless VPS, cause unknown.

### Hermes

Source: NousResearch/hermes-agent `645da65`.

**Device flow.**
- Invoked as `hermes mcp login <name> --flow device`, or with `oauth.flow: device`.
- It registers via DCR with the `device_code` grant and sends the RFC 8707 `resource`.
- It prints `verification_uri` and `user_code` to stderr, and runs from a terminal only. Background reconnects never start it.
- An agent with the terminal tool can run it in the background and relay the link and code in chat.

**Browser flow.**
- Loopback `http://127.0.0.1:<redirect_port or 8420>/callback`. Its CIMD document lists ports 27890-27894.
- Whether Hermes supports a public, hosted callback was not checked.

### Authorization servers

**WorkOS AuthKit, as used by AgentPit.**
- It supports DCR, CIMD and device flow.
- CIMD redirects must match exactly, except the loopback port.
- Verified on WorkOS staging, 2026-09-24:
  - A DCR registration shaped like OpenClaw's (`token_endpoint_auth_method none`, authorization_code and refresh_token), with `redirect_uris` `https://clawbits.ai/oauth/mcp/callback/probe` and `https://pit.clawbits.ai/connected`, returned 201.
  - Authorize requests with either callback went on to the AuthKit sign-in page.
  - An unregistered callback got `invalid_redirect_uri`. Matching is exact, so one fixed path per agent is fine.
  - Production accepts `resource=https://api.agentpit.dev/mcp`, and rejects other resources with `invalid_target`.

**Other providers.** Their DCR policies vary. Keep a fallback: the chat can always ask the human to paste the code back.

## 4. Options

Both options below rest on the facts above. Pick with your knowledge of reef networking and the plugin, or find a better one.

**A. OpenClaw-native: per-requester mode plus `gateway.publicOrigin`.**
- Each hosted gateway gets a public https origin (for example a per-agent subdomain, or a clawbits ingress route) that reaches the gateway's `/oauth/mcp/callback`.
- OpenClaw handles state, PKCE, the page and the token store. clawbits writes no OAuth code.
- To check:
  - How per-requester identity maps to clawbits chat senders through the clawbits channel.
  - How the sign-in link is triggered and delivered in a clawbits chat.
  - What happens with the owner versus other people chatting with the same agent.
  - What public ingress per gateway costs.

**B. clawbits relay page: shared identity plus `oauth.redirectUrl` pointing at clawbits.**
- For example `https://<clawbits host>/oauth/mcp/callback/<agentId>`, one path per agent so the page knows which agent it serves.
- `openclaw mcp login` prints the link and exits.
- The page:
  1. Receives `code` and `state`.
  2. Checks that the signed-in clawbits user may act for that agent.
  3. Delivers the code to the agent. Either post it into the agent's chat, where the agent runs `openclaw mcp login <name> --code <code>` itself, or have the plugin run that command.
  4. Shows "Connected. Return to the chat."
- No per-gateway public ingress. Works in shared mode on any OpenClaw 2026.8.1 or later.
- To check:
  - Mapping the callback to the right server name when an agent signs into several servers at once. The `state` value or the pending authorize URL can disambiguate.
  - Never logging codes.

**Either way, the key integration point** is getting the setting (redirect or identity) onto servers the agent adds itself.
- AgentPit's skill.md currently tells OpenClaw to run `openclaw mcp set agentpit '{"url":"https://api.agentpit.dev/mcp","transport":"streamable-http","auth":"oauth"}'`, then `openclaw mcp login agentpit`. That JSON carries no `oauth` block.
- Find whether OpenClaw has a gateway-wide default. If not, the options are:
  - The clawbits agent soul or system prompt tells the agent to always add clawbits' `oauth` block when it adds an OAuth MCP server, for example from an env var.
  - A plugin hook patches the config.
  - AgentPit's skill.md gains a line such as "if your host gives you an MCP OAuth redirect URL, add it as `oauth.redirectUrl`".
- Tell AgentPit which one you choose, so skill.md can match.

**Hermes.** Pick the equivalent: a hosted callback if Hermes supports one, otherwise device flow, with the agent relaying the link and code in chat.

**Existing agents.** Agents that already registered a loopback DCR client need `openclaw mcp logout <name>` once to pick up the new redirect.

## 5. Acceptance

1. **Fresh hosted OpenClaw agent.** Paste "Read https://pit.clawbits.ai/skill.md and follow it to join AgentPit."
   - The agent sends a sign-in link or button.
   - The human signs in and lands on the clawbits "Connected" page, with no copy-paste.
   - On its next turn the agent calls `portfolio` and says "I'm on AgentPit as <name>".
2. **A second OAuth MCP server from another provider** works the same way. This proves the fix is generic.
3. **Restart and upgrade.** A container restart and an image upgrade keep the sign-in.
4. **Hermes image.** It reaches the same outcome, or the documented best available.
5. **Tests** cover the clawbits pieces you build (callback routing, authorization of the clawbits user, delivery to the agent).

## 6. Coordination with AgentPit

- **WorkOS check: passed.** WorkOS DCR accepts an https callback on a clawbits domain (see section 3). The one step not yet exercised is a completed sign-in landing on such a callback; your end-to-end test covers it.
- **Refresh tokens.** WorkOS access tokens last 1 hour, and WorkOS issues a refresh token only when the authorize request asks for `offline_access`. The MCP spec (2026-07-28, Refresh Tokens) puts that on the client: servers should not advertise `offline_access`, and clients may request it when the authorization server lists it, as WorkOS does. OpenClaw sends no scope unless `oauth.scope` is set, so a server entry without `"scope":"openid offline_access"` loses access after an hour. AgentPit's skill.md now sets it. Whatever `oauth` block clawbits applies to agent-added servers should include it too, or clawbits should keep the agent's own scope.
- **AgentPit's fallback.** AgentPit may also host its own "copy this code to your agent" page for OpenClaw installs outside clawbits. It does not conflict with a clawbits-configured redirect: whichever `redirectUrl` the server entry carries wins.
- **Report back:**
  - the chosen option;
  - the callback URL format;
  - how the agent learns the redirect or identity setting;
  - any change AgentPit's skill.md should make.

## 7. Out of scope

- AgentPit code.
- Device flow for OpenClaw, which does not exist.
- OpenClaw gateways that clawbits does not host. They keep loopback, or paste the code back.

## 8. Resolution (clawbits, 2026-09-24)

**Chosen:** a Clawbits relay. It is neither option A nor the paste-into-chat form of B.
- Option A is out. Per-requester keeps one token per human who chats with the agent, and cron turns lose the tools. OpenClaw also refuses `mcp login` for such servers, and the gateway would need public ingress.
- The paste-into-chat form of B is out, because it puts the code into chat history and relies on the model to finish the sign-in.

**Callback URL:** `https://app.clawbits.ai/oauth/mcp/callback/<agentId>/<server>`, one URL per agent and server. The origin follows the deployment's app URL. The authorization server's exact match routes each code to the agent that registered it. AgentPit's staging check confirmed WorkOS accepts this.

**How the agent gets it: it doesn't have to.**
- In a Clawbits chat turn, before `openclaw mcp login <name>` runs, the clawbits plugin runs `openclaw mcp logout <name>` and then `openclaw mcp configure <name> --oauth-redirect-url <callback>`. The logout clears any client registered for the old loopback redirect.
- The callback base comes from Clawbits over the agent's WebSocket, and only reef-hosted agents get it. Self-hosted gateways keep loopback.
- After the login runs, the plugin registers the exact authorization URL that OpenClaw printed.
- The rest of the flow:
  1. The human clicks the sign-in link inside the Clawbits chat, in a message the agent itself wrote. They must be the agent's operator or an org admin. The same link reposted by anyone else does nothing.
  2. Clawbits opens the link the plugin registered, with a fresh `state` that only this click holds. The `state` posted in chat is never accepted, so a crafted or redirected link cannot finish a sign-in.
  3. The provider returns to the Clawbits page, which relays the code over the agent's WebSocket.
  4. The plugin runs `openclaw mcp login <name> --code=<code>`. OpenClaw's `--code` path ignores `state`, and PKCE still binds the code to this agent.
  5. The page shows "Connected" only after that succeeds, and the agent confirms in the chat.

**skill.md for OpenClaw.** Nothing is required. Recommended:
- Run `openclaw mcp login agentpit` as its own command. Do not chain it after `openclaw mcp set` with `&&`: the plugin blocks a chained login once and asks for a separate run.
- Add `"oauth":{"scope":"offline_access"}` to the `mcp set` JSON so WorkOS issues a refresh token. The MCP spec (2026-07-28) puts `offline_access` on the client, and OpenClaw 2026.9.x does not add it itself. The plugin's `configure` merges into the block and keeps the scope.
- Do not set `oauth.redirectUrl`; the host owns it.
- Tell the agent to post the sign-in link itself, unchanged, as a clickable link. The human has to open it from that message in the Clawbits chat: a link opened anywhere else is refused.

**Hermes.** The best option available is device flow:
- Add the server to `/opt/data/config.yaml` under `mcp_servers.agentpit` with `url` and `auth: oauth`. Non-interactive `hermes mcp add --auth oauth` saves nothing.
- Run `hermes mcp login agentpit --flow device` in the background and relay the verification URL and the user code.
- It works with WorkOS. Linear, Notion and Atlassian have no device grant.
- Tools can take up to 5 minutes to appear, because a parked server re-probes every 300 s.
- A hosted callback for Hermes is possible through its `DashboardOAuthFlow` bridge. It is not built.

**Corrections to section 3.** Checked against OpenClaw 2026.9.5 (prod) and 2026.9.6 (dev).
- In 2026.9.5 the default redirect is in `src/agents/mcp-oauth-provider.ts:18`.
- Shared mode does store `state`, in `mcp_oauth_pending_authorizations`.
- Per-requester OAuth is #122166.
- Grok Bot's callback is `https://www.cursor.com/agents/mcp/oauth/callback`.
- Hermes supports a public `redirect_uri` and a hosted bridge, but has no `--code`.

**Status.** Built and tested with unit and integration tests. Not deployed. Going live needs:
- a backend deploy;
- a plugin release;
- an image rebuild;
- the reef role change.
The live end-to-end runs (AgentPit plus two other providers, restart and upgrade) are still pending.

**Won't work through this yet:**
- GitHub, Asana v2 and Box need a pre-registered client.
- Atlassian, Intercom, Canva, Figma and Vercel need the Clawbits callback allowlisted or approved.
