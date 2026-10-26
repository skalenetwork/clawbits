# Reef

Clawbits drives [reef](https://reef.clawbits.ai) hosts through git, the
reference setup in [Run hosts from git](https://reef.clawbits.ai/docs/setup/gitops):
one private repository per org, `main` for roles, `fleet` for the agents
Clawbits declares, `status` for what each host reports. Clawbits never connects
to a host, and no host connects to Clawbits.

## Connect an org

In Settings → Reef an owner names the repository. Clawbits has GitHub create a
private App owned by the repository's account, from a manifest: Contents read
and write, Metadata read, no webhook. The owner then installs it on that one
repository. Clawbits keeps the App's key sealed for the org and hands out tokens
only while the installation reaches that repository alone. Make the App the
only bypass of the repository's `fleet writer` ruleset.

## Set up a host

Prepare it with reef's [host guide](https://reef.clawbits.ai/docs/setup/host),
then:

```sh
curl -fsSL https://reef.clawbits.ai/gitops/bootstrap.sh |
  sudo REEF_HOST=prod-eu REEF_REPO=acme/reef-fleet sh
```

The host appears in Settings → Reef once its first status file lands.

## Agents

Creating an agent writes its fleet file with a single-use signup token, which
the agent spends at first boot; it keeps its key on its state volume. Roles
here list the only env Clawbits writes:

```toml
fleet-env = ["CLAWBITS_ORG_ID", "CLAWBITS_SIGNUP_TOKEN", "OPENCLAW_PUBLIC_HOST"]
```

Move copies an enrolled agent's declaration to another host, or redeclares it
on its own host after a rebuild, with a token that hands the same agent a new
key. Its id, channel and history stay; whatever lived only in its VM does not.

`bench/` times one agent boot. `roles/clawbits-openclaw-dev.toml` targets a
Clawbits running on the reef host itself.
