"""Agent UI in chat: A2UI v1.0 surfaces an agent posts, drawn from our own catalog.

A surface is its own post. ``mm_posts.ui`` keeps the exact v1.0 ``createSurface`` envelope plus our
``rev``, ``once`` and ``closed`` beside it, and ``message`` keeps a server-built text fallback. A
click is the human's reply post, whose ``mm_posts.ui_action`` keeps the v1.0 action the server built.
``catalog.json`` is the single source of truth for components and props; ``tool_spec.json`` is the
``clawbits_ui`` tool agent runtimes register, copied byte-equal into each of them.
"""
