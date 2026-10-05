# Boot bench

Times one OpenClaw agent boot on this host, from `reef fleet apply` to clawbits
connected, outside the git bus and the host's own agents.

```sh
reef/bench/run.sh ROLE.toml [IMAGE]
```

- One agent, `bench`, in its own reef state (`~/.local/state/reef-bench`), on
  ROLE with no host ports. Each run recreates it and keeps its volumes;
  `FRESH=1` wipes them first.
- The state needs the role's secrets:
  `mkdir -p ~/.local/state/reef-bench && ln -s ../reef/secrets.toml ~/.local/state/reef-bench/`
- `SIGNUP=FILE` signs up on first boot: a 0600 file holding
  `CLAWBITS_ORG_ID = "…"` and `CLAWBITS_SIGNUP_TOKEN = "…"`.
- `END=ready` stops at gateway ready, for an agent with no identity.
- `reef/bench/run.sh clean` removes the agent and its volumes.
