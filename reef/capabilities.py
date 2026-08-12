"""Per-agent opt-in capabilities.

A capability is something an agent may reach that the microVM boundary does NOT
contain. That is the whole selection rule, and it is why this list is short.

Everything an agent can already do inside its own VM - arbitrary shell, package
installs, browser automation, writing its own files - is deliberately NOT here.
Those are contained by the microVM, so gating them would be ceremony: the agent
runs unattended with ``tools.exec`` at ``security=full`` by design, and
``tools.fs.workspaceOnly`` defaults false, so it can rewrite its own OpenClaw
config anyway. A per-agent flag only means something when the blast radius
crosses the VM boundary into something the operator's customer owns.

Both capabilities here clear that bar:

* ``gh`` - a credentialed GitHub CLI. An injected agent pushes branches, opens
  PRs and reads private repos in the customer's org, attributably and durably.
* ``cron`` - self-scheduled recurring work. Not a privilege escalation (the agent
  already has full exec) but a PERSISTENCE grant: an injected loop outlives the
  conversation and the context window.

Deliberately excluded, with reasons, so nobody re-litigates them by accident:

* ``group:messaging`` - sending to other humans/agents in the org. The one
  capability whose blast radius leaves the VM with no boundary at all. Off, and
  not exposed as a toggle. (Note ``tools.profile="full"`` would silently include
  it, which is why the entrypoint uses ``tools.alsoAllow`` instead.)
* ``browser`` - fleet-wide ON. It is a resource decision, not a trust one, and
  the VM contains it.
"""

# Wire values are a stable API: they are persisted in the store, replayed on
# upgrade, and sent by two different frontends. Renaming one is a migration.
CAP_GH = "gh"
CAP_CRON = "cron"

CAPABILITIES: tuple[str, ...] = (CAP_GH, CAP_CRON)

# Granted when a caller omits the field entirely. NOT "the safe baseline is
# everything" - the two capabilities are defaulted differently on purpose:
#
# * ``gh`` is ON. It is the one capability with a SECOND, harder gate underneath
#   it: reef injects no GitHub token, so an ungranted `gh` and a granted one are
#   equally powerless until a human supplies a credential. Leaving it off by
#   default therefore bought no containment - it only produced `gh: command not
#   found` on an agent the operator had already pointed at a repo, which reads as
#   a broken image rather than a policy decision.
# * ``cron`` stays OFF. Nothing gates it a second time: the moment it is granted
#   the agent can schedule work that outlives the conversation, so the grant has
#   to be a deliberate act.
#
# An explicit ``[]`` still means "nothing" - the default applies to OMISSION only,
# so a caller that wants a bare agent can always say so (see FleetService.create).
DEFAULT_CAPABILITIES: tuple[str, ...] = (CAP_GH,)

# Guest env var carrying the granted set (comma-separated, stable order) for the
# entrypoint to act on. Under the ``REEF_`` prefix, so it is reserved from
# caller-supplied env (see fleet._validate_user_env) and cannot be self-granted
# through the create API's generic ``env`` passthrough.
CAPS_ENV = "REEF_CAPS"


def normalize(values) -> tuple[str, ...]:
    """Validate and canonicalize a capability list.

    Accepts either a sequence of names (the API/store shape) or a single
    comma-separated string. The string form matters because ``creds`` is
    ``dict[str, str]``, so a profile receives ``"gh,cron"`` - iterating that as a
    sequence would walk it character by character.

    Deduplicates and sorts into ``CAPABILITIES`` order so the persisted value and
    the guest env are stable regardless of caller ordering (an unstable value
    would make every upgrade look like a change). Raises ``ValueError`` (→ 422)
    on an unknown name rather than silently dropping it: silently ignoring a
    capability the caller asked for would hand back an agent that is less capable
    than the UI just claimed.
    """
    if not values:
        return ()
    if isinstance(values, str):
        values = [v for v in values.split(",") if v.strip()]
    seen = set()
    for value in values:
        if not isinstance(value, str):
            raise ValueError(f"invalid capability {value!r}: expected a string")
        name = value.strip().lower()
        if name not in CAPABILITIES:
            valid = ", ".join(CAPABILITIES)
            raise ValueError(f"unknown capability {value!r}; expected one of: {valid}")
        seen.add(name)
    return tuple(c for c in CAPABILITIES if c in seen)


def to_env(capabilities) -> dict[str, str]:
    """Guest env for a granted set. Always sets the var - an explicit empty value
    lets the entrypoint tell "no capabilities" apart from "this reef predates
    capabilities", so it can actively turn the features OFF rather than leaving
    whatever a previous boot wrote in the agent's persisted config."""
    return {CAPS_ENV: ",".join(normalize(capabilities))}
