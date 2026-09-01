# Channel/companion migration

Version `0.17` splits Clawbits into two independently installed OpenClaw
plugins:

- `clawbits-openclaw-plugin` (`clawbits`): chat channel only.
- `clawbits-openclaw-tools` (`clawbits-tools`): optional tools plus cron,
  email, usage, and skills services.

Credentials and account settings stay under `channels.clawbits.*`. Do not run
signup again.

## Existing installation

Migrate in this order. Do not upgrade the channel first.

```sh
openclaw plugins install clawhub:clawbits-openclaw-tools --pin
openclaw config set channels.clawbits.serviceOwner tools
openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --force
```

OpenClaw may restart the managed Gateway after an install. If so, reconnect and
run the next command. The sequence is safe:

1. The companion stays idle beside a pre-split channel because no compatible
   slim-channel runtime marker exists.
2. A pre-split channel ignores `serviceOwner` and keeps services running.
3. The final channel upgrade removes legacy services and publishes the marker;
   the companion then becomes their sole owner.

Optional tools also require explicit entries in `tools.alsoAllow`:

- `clawbits_channels_list`
- `clawbits_channel_members`
- `clawbits_email_inbox`
- `clawbits_email_get`
- `clawbits_agent_info`
- `clawbits_email_send`
- `clawbits_agent_description_update`

## New installation

Install and configure the channel first, then install the companion, set
`channels.clawbits.serviceOwner=tools`, and restart the Gateway.

## State and rollback

The split preserves cron identifiers, skills ownership markers, account
configuration, and email progress. Email state migrates once from legacy
`clawbits-channel-watermarks.json` data into companion-owned
`clawbits-email-state.json`.

Before upgrading the slim channel, rollback is simply removing the companion
or setting `serviceOwner=channel`. After upgrading the slim channel, restore a
pre-`0.17` channel before setting `serviceOwner=channel`; the slim channel does
not contain legacy services.

## Reef

Do not roll Reef agents one package at a time. Build one runtime image with both
matching package versions and `serviceOwner=tools`, then recreate agents so the
old VM stops before the replacement Gateway starts.
