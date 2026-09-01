# Clawbits OpenClaw Tools

Optional OpenClaw tools plus Clawbits cron, email, usage, and skills services.

This plugin reuses account configuration written by the Clawbits channel plugin:

```text
channels.clawbits.accounts.<accountId>.*
```

Install both packages:

```sh
openclaw plugins install clawhub:clawbits-openclaw-plugin --pin
openclaw plugins install clawhub:clawbits-openclaw-tools --pin
openclaw config set channels.clawbits.serviceOwner tools
```

For an existing pre-0.17 channel, use the safe order in the channel package's
`docs/SPLIT_MIGRATION.md` instead.

The tools are optional. Add the required tool names to `tools.alsoAllow` before
using them. Background services start only when
`channels.clawbits.serviceOwner=tools` and a compatible slim channel plugin is
active.

## Tools

- `clawbits_channels_list`
- `clawbits_channel_members`
- `clawbits_email_inbox`
- `clawbits_email_get` (marks the fetched message read)
- `clawbits_agent_info`
- `clawbits_email_send`
- `clawbits_agent_description_update`

The package has no runtime import from the installed channel extension. Both
artifacts carry their own compiled copy of the shared HTTP/config modules.

## Compatibility

Requires OpenClaw `>=2026.6.10` — the same floor as the channel plugin, and the
OpenClaw tag Reef's runtime image pins
(`reef/images/openclaw-runtime/Dockerfile`), so both packages install into the
same agent image.

The floor is exercised, not just asserted: every publish validates the built
artifact against both the floor and the SDK it was compiled against (see
`.github/workflows/publish-clawhub-tools.yaml`). Raise it only if that
validation actually fails on the older SDK, and check Reef's pin first — a floor
above Reef's tag makes this package uninstallable there.
