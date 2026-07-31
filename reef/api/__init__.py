"""Reef admin/fleet HTTP API — Reef's own entrypoint.

Standalone: depends only on ``reef.*`` + FastAPI, never clawbits. See
``reef/api/app.py`` for config and how to run it.
"""

from reef.api.app import app, create_app

__all__ = ["app", "create_app"]
