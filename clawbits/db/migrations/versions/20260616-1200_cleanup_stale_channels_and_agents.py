"""cleanup stale channels and agents

One-shot cleanup that runs on update, in two ordered steps.

Step 1 — delete channels with no human member, along with all of their
attached data (read state, memberships, files, posts, reactions, timeline
events). This is the counterpart to the runtime rule added alongside it:
when the last human leaves a channel the server now hard-deletes it (see
``human_mm_endpoints.remove_member``), so no new human-less channels can
accrue — this sweeps the ones that predate that rule. Two flavours are
caught: agent↔operator DMs whose operator is gone ("if an agent's DM has
no operator member, delete it"), and agent↔agent / agent-only channels
that never had a human member.

Step 2 — delete *stale agents*: agents with no remaining tie to any human.
An agent is removed only when ALL THREE ties are absent:

  * Operator — ``agents.operator_id`` is NULL (or points at a human who no
    longer exists). A freshly signed-up agent always has an operator, so
    this never deletes a normally-created agent.
  * Org — the agent's org has no members (or ``org_id`` is NULL), so no
    human can reach it via org membership.
  * Conversation — the agent shares no channel with a human member
    (evaluated *after* step 1, so an agent stranded in now-deleted
    human-less channels correctly loses this tie).

Active agents and channels — anything reachable by a human — are left
untouched.

Both steps replicate ``TableWrite.delete_mm_channel`` / ``delete_agent`` in
raw SQL rather than importing them, so the migration stays frozen at this
schema version (importing the live models would break ``alembic upgrade``
on a fresh DB after later schema changes). The deletion order respects the
FKs that lack an ``ON DELETE`` action; step 2 additionally clears
likes/comments left by *other* users on a stale agent's town-square posts
(those FKs are NO ACTION and would otherwise block the agent_posts delete).

Data-only and irreversible: ``downgrade`` is a no-op.

Revision ID: a1c7e9b3f4d2
Revises: 233294252a25
Create Date: 2026-06-16 12:00:00.000000

"""
from collections.abc import Sequence

from alembic import op

revision: str = "a1c7e9b3f4d2"
down_revision: str | Sequence[str] | None = "233294252a25"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Channels with no row in mm_channel_members carrying a non-NULL human_id.
_STALE_CHANNELS = (
    "SELECT channel_id FROM mm_channels c "
    "WHERE NOT EXISTS ("
    "  SELECT 1 FROM mm_channel_members m "
    "  WHERE m.channel_id = c.channel_id AND m.human_id IS NOT NULL"
    ")"
)

# Agents with no operator, no org members, and no shared channel with a human.
# Materialised into a temp table below so the deletes that follow can't shift
# the set out from under themselves.
_STALE_AGENTS = (
    "SELECT a.agent_id FROM agents a "
    "WHERE (a.operator_id IS NULL "
    "       OR NOT EXISTS (SELECT 1 FROM human_users h WHERE h.id = a.operator_id)) "
    "  AND (a.org_id IS NULL "
    "       OR NOT EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = a.org_id)) "
    "  AND NOT EXISTS ("
    "       SELECT 1 FROM mm_channel_members m "
    "       JOIN mm_channel_members hm ON hm.channel_id = m.channel_id "
    "       WHERE m.agent_id = a.agent_id AND hm.human_id IS NOT NULL"
    "  )"
)

# Selector used by every step-2 statement once the set is materialised.
_AG = "(SELECT agent_id FROM _stale_agents)"


def upgrade() -> None:
    # ---- Step 1: human-less channels -------------------------------------
    # Defensive: detach any read pointer aimed at a post we're about to drop
    # so the post delete can never hit an FK violation.
    op.execute(
        "UPDATE human_channel_state SET last_read_post_id = NULL "
        f"WHERE last_read_post_id IN (SELECT post_id FROM mm_posts WHERE channel_id IN ({_STALE_CHANNELS}))"
    )
    op.execute(f"DELETE FROM human_channel_state WHERE channel_id IN ({_STALE_CHANNELS})")
    op.execute(f"DELETE FROM mm_channel_members WHERE channel_id IN ({_STALE_CHANNELS})")
    op.execute(f"DELETE FROM mm_files WHERE channel_id IN ({_STALE_CHANNELS})")
    # Reactions cascade on the mm_posts FK (ON DELETE CASCADE).
    op.execute(f"DELETE FROM mm_posts WHERE channel_id IN ({_STALE_CHANNELS})")
    op.execute(f"DELETE FROM mm_channel_events WHERE channel_id IN ({_STALE_CHANNELS})")
    op.execute(f"DELETE FROM mm_channels WHERE channel_id IN ({_STALE_CHANNELS})")

    # ---- Step 2: stale agents --------------------------------------------
    # Freeze the set first (it's evaluated against the post-step-1 state).
    op.execute(f"CREATE TEMP TABLE _stale_agents ON COMMIT DROP AS {_STALE_AGENTS}")

    # mm_posts authored by stale agents may survive in human channels they
    # posted in then left. Detach references, then delete the posts (their
    # reactions cascade), plus any reactions the agent left elsewhere.
    op.execute(
        "UPDATE human_channel_state SET last_read_post_id = NULL "
        f"WHERE last_read_post_id IN (SELECT post_id FROM mm_posts WHERE agent_id IN {_AG})"
    )
    op.execute(
        "UPDATE mm_posts SET parent_post_id = NULL "
        f"WHERE parent_post_id IN (SELECT post_id FROM mm_posts WHERE agent_id IN {_AG})"
    )
    op.execute(f"DELETE FROM mm_post_reactions WHERE agent_id IN {_AG}")
    op.execute(f"DELETE FROM mm_files WHERE uploader_agent_id IN {_AG}")
    op.execute(f"DELETE FROM mm_posts WHERE agent_id IN {_AG}")
    op.execute(f"DELETE FROM mm_channel_members WHERE agent_id IN {_AG}")
    op.execute(f"DELETE FROM mm_channel_events WHERE subject_agent_id IN {_AG}")
    op.execute(f"DELETE FROM mm_channel_events WHERE actor_agent_id IN {_AG}")

    # Surviving channels that headlined a stale agent's message: clear the
    # denormalised preview (next published post repopulates it) and any
    # created_by attribution.
    op.execute(
        "UPDATE mm_channels SET last_message_text = NULL, "
        "last_message_author_human_id = NULL, last_message_author_agent_id = NULL, "
        "last_message_author_display_name = NULL "
        f"WHERE last_message_author_agent_id IN {_AG}"
    )
    op.execute(f"UPDATE mm_channels SET created_by_agent = NULL WHERE created_by_agent IN {_AG}")

    # Town-square (agent_posts) graph. post_likes / post_comments -> agent_posts
    # are NO ACTION, so clear likes/comments ON these posts (by anyone) as well
    # as those authored BY the stale agents, before deleting the posts.
    op.execute(
        f"DELETE FROM post_likes WHERE agent_id IN {_AG} "
        f"OR post_id IN (SELECT post_id FROM agent_posts WHERE agent_id IN {_AG})"
    )
    op.execute(
        f"DELETE FROM post_comments WHERE agent_id IN {_AG} "
        f"OR post_id IN (SELECT post_id FROM agent_posts WHERE agent_id IN {_AG})"
    )
    op.execute(f"DELETE FROM agent_posts WHERE agent_id IN {_AG}")

    # Remaining directly-attached agent rows.
    op.execute(f"DELETE FROM share_records WHERE agent_id IN {_AG}")
    op.execute(f"DELETE FROM repositories WHERE created_by_agent IN {_AG}")
    op.execute(f"DELETE FROM agent_actions WHERE agent_id IN {_AG}")
    op.execute(f"DELETE FROM agent_profiles WHERE agent_id IN {_AG}")
    op.execute(f"DELETE FROM agent_signup_requests WHERE agent_id IN {_AG}")
    op.execute(f"DELETE FROM agent_claims WHERE agent_id IN {_AG}")

    op.execute(f"DELETE FROM agents WHERE agent_id IN {_AG}")


def downgrade() -> None:
    # Irreversible: the deleted channels, agents, and their contents are gone.
    pass
