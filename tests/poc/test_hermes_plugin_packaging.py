"""Packaging guards for the Hermes plugin, which ships as a standalone directory
(``git archive`` into the image, ``cp -R`` by reinstall.sh) and runs on Hermes's
Python (3.11+), while CI runs only the repo's Python."""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

_PLUGIN_DIR = Path(__file__).resolve().parents[2] / "extensions" / "hermes"
_PLUGIN_FILES = sorted(_PLUGIN_DIR.rglob("*.py"))
_HERMES_MIN_PYTHON = (3, 11)


def _absolute_imports(path: Path) -> list[str]:
    names = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.append(node.module)
    return names


def test_plugin_files_are_found():
    assert _PLUGIN_DIR / "pinned_http.py" in _PLUGIN_FILES
    assert any(p.parent.name == "agent-cli" for p in _PLUGIN_FILES)


def test_plugin_never_imports_the_backend():
    offenders = [
        f"{p.relative_to(_PLUGIN_DIR)}: {name}"
        for p in _PLUGIN_FILES
        for name in _absolute_imports(p)
        if name.split(".")[0] == "clawbits"
    ]
    assert offenders == []


def test_pinned_http_is_stdlib_only():
    roots = {name.split(".")[0] for name in _absolute_imports(_PLUGIN_DIR / "pinned_http.py")}
    assert roots <= set(sys.stdlib_module_names) | {"__future__"}


@pytest.mark.parametrize("path", _PLUGIN_FILES, ids=lambda p: str(p.relative_to(_PLUGIN_DIR)))
def test_plugin_parses_on_hermes_minimum_python(path):
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path), feature_version=_HERMES_MIN_PYTHON)


def test_minimum_python_parse_rejects_newer_syntax():
    with pytest.raises(SyntaxError):
        ast.parse("type Alias = int\n", feature_version=_HERMES_MIN_PYTHON)
