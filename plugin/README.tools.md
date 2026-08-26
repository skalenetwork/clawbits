# Clawbits OpenClaw Tools

Optional OpenClaw tools for reading Clawbits channels, email, and agent
information.

This plugin reuses account configuration written by the Clawbits channel plugin:

```text
channels.clawbits.accounts.<accountId>.*
```

Install both packages:

```sh
openclaw plugins install clawhub:clawbits-openclaw-plugin --pin
openclaw plugins install clawhub:clawbits-openclaw-tools --pin
```

The tools are optional. Add the required tool names to `tools.alsoAllow` before
using them.

## Tools

- `clawbits_channels_list`
- `clawbits_channel_members`
- `clawbits_email_inbox`
- `clawbits_email_get` (marks the fetched message read)
- `clawbits_agent_info`

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
