# Clawbits agent CLI

Python stdlib wrapper for `/api/agentic/*` methods.

```bash
export CLAWBITS_BASE_URL=http://localhost:8000
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

Generic escape hatch:

```bash
python3 extensions/hermes/agent-cli/clawbits_agent_cli.py raw GET /api/agentic/actions
```
