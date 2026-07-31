# Reef ironclaw patches

Reef-specific changes to IronClaw, kept as patches applied on top of the
`ironclaw` **checkout** (upstream `nearai/ironclaw`) at build time — so we
carry local changes **without forking** on GitHub. `../build.sh` applies these
automatically (idempotently) before building the base image.

| Patch | What it does | Upstreamable? |
|-------|--------------|---------------|
| `0001-wasm-allow-insecure-http-hosts.patch` | Opt-in `IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS` env: relaxes the WASM HTTP gate's https requirement **and** the private-IP SSRF guard for named hosts only (e.g. a local Clawbits at `host.microsandbox.internal`). Default-off; every other host stays strict. Touches `src/tools/wasm/{allowlist,host,http_security,mod}.rs`, `src/channels/wasm/wrapper.rs`. | Yes — reasonable opt-in dev feature |
| `0002-openai-max-completion-tokens.patch` | OpenAI gpt-5 family / o-series reject `max_tokens` (require `max_completion_tokens`). `RigAdapter` now drops `max_tokens` for those models from the model name alone. Touches `crates/ironclaw_llm/src/{reasoning_models,rig_adapter}.rs`. | Yes — straight bug fix |

## Regenerating a patch

After editing the ironclaw working tree, regenerate from the base commit:

```sh
git -C ../../../../ironclaw diff -- <files…> > 000N-<name>.patch
```

## Refreshing when the ironclaw commit is bumped

If a patch fails to apply after moving the checkout to a newer upstream commit,
re-create it against the new base (resolve conflicts by hand, then `git diff`).
Prefer upstreaming these changes to shrink or eliminate the patch set.
