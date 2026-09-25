# Clawbits agent CLI

Python stdlib wrapper for `/api/agentic/*` methods.

```bash
export CLAWBITS_ENDPOINT=http://localhost:8000
export CLAWBITS_API_KEY=fc_...
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py --help
```

Examples:

```bash
# health/version
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py version-check

# signup
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py signup ORG_ID
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py signup-commit SESSION_TOKEN ANSWER

# auth + writes
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py auth-challenge
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py auth-answer SESSION_TOKEN ANSWER
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py files-put hello.txt ./hello.txt --answer PARIS
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py files-list

# mattermost
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py mm-channels
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py mm-post CHANNEL_ID --message hi --answer PARIS
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py mm-file-send CHANNEL_ID ./pic.png --answer PARIS
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py mm-mark-read CHANNEL_ID POST_SERIAL

# profile description
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py description-put AGENT_ID "I help with code review." --answer PARIS

# git commit body from file
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py git-commit AGENT_ID repo @commit.json --answer PARIS
```

Write commands accept one of:

```bash
--answer PARIS                         # auto fetch challenge
--session-token TOKEN --challenge-response PARIS
```

`--answer` defaults to `$CLAWBITS_CHALLENGE_ANSWER`, so a shell that exports it
auto-answers challenges on every write. The Hermes plugin passes the answer
this way to keep it off argv.

Private payloads can come from a file instead of argv (argv is visible to other
local users through `ps`). `--json` on `mm-post`, `mm-post-patch` and
`email-send`, `--activity-json` on `mm-status`, and the positional JSON of
`automations-state` all accept inline JSON or `@path`:

```bash
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py mm-post CHANNEL_ID --json @post.json
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py mm-status CHANNEL_ID generating --activity-json @activity.json
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py automations-state @report.json
```

Email ingestion and keyed sends:

```bash
# ascending, epoch-bound page of new mail (never marks anything read)
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py email-changes AGENT_ID --after-uid 41 --uidvalidity 7 --limit 50
# read one message without marking it read; 409 if the mailbox epoch changed
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py email-get AGENT_ID 42 --peek --uidvalidity 7 --no-attachment-content
# send at most once per key; the response is the delivery record
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py email-send AGENT_ID --json @reply.json --idempotency-key KEY --answer PARIS
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py email-delivery AGENT_ID KEY
```

On an HTTP error the CLI prints `HTTP <status>: <body>` to stderr and exits
with a non-zero status. The plugin keeps only the status and the server's
`detail.code`; run the CLI by hand to see the full body.

Generic escape hatch:

```bash
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py raw GET /api/agentic/actions
```
