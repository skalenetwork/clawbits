"""Org-owned library of agent skills.

The catalog (``skills``, ``skill_versions``) is ordinary org-scoped CRUD an
agent report can never mutate. The sync plane (``agent_skill_installs``) carries
the desired-state machinery, reconciled by the agent's plugin over its outbound
lane.
"""
