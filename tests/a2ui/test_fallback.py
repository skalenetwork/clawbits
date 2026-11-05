"""The text fallback a surface post keeps in ``message``: read from root down, short and plain."""
from __future__ import annotations

from clawbits.a2ui.fallback import fallback_text


def _root(component: str, **props) -> dict:
    return {"id": "root", "component": component, **props}


def test_a_status_card_reads_top_down():
    components = [
        _root("Card", child="body"),
        {"id": "body", "component": "Column", "children": ["title", "stats", "row", "note", "kv", "runs", "hosts"]},
        {"id": "title", "component": "Text", "text": "**Deploy health**"},
        {"id": "stats", "component": "Stats", "items": [
            {"label": "Uptime", "value": "99.98", "unit": "%", "delta": "+0.02", "trend": "up"},
            {"label": "Errors", "value": "3"},
        ]},
        {"id": "row", "component": "Row", "children": ["docs", "rule", "deploy"]},
        {"id": "docs", "component": "Button", "child": "docs_label",
         "action": {"functionCall": {"@call": "openUrl", "args": {"url": "https://example.com/runs"}}}},
        {"id": "docs_label", "component": "Text", "text": "All runs"},
        {"id": "rule", "component": "Divider"},
        {"id": "deploy", "component": "Button", "child": "deploy_label", "action": {"event": {"name": "deploy"}}},
        {"id": "deploy_label", "component": "Text", "text": "Deploy"},
        {"id": "note", "component": "Notice", "tone": "warn", "title": "s2 is warm", "text": "CPU above 75%."},
        {"id": "kv", "component": "KeyValue", "items": [{"label": "Region", "value": "eu-west"}, {"label": "Tier", "value": "2"}]},
        {"id": "runs", "component": "StatusList", "items": [
            {"title": "api v2.4.1", "subtitle": "3 min ago", "tone": "ok"},
            {"title": "web v1.9.0", "tone": "bad"},
        ]},
        {"id": "hosts", "component": "Table", "caption": "Hosts", "headers": ["Host", "CPU"], "rows": [["s1", 42], ["s2", 77.5]]},
    ]
    assert fallback_text(components) == "\n".join([
        "**Deploy health**",
        "Uptime: 99.98 % (+0.02)",
        "Errors: 3",
        "All runs (https://example.com/runs)",
        "Deploy",
        "s2 is warm: CPU above 75%.",
        "Region: eu-west",
        "Tier: 2",
        "- api v2.4.1 (3 min ago)",
        "- web v1.9.0",
        "Hosts",
        "Host | CPU",
        "s1 | 42",
        "s2 | 77.5",
    ])


def test_charts_read_as_compact_data_lines():
    components = [
        _root("Column", children=["bar", "pie"]),
        {"id": "bar", "component": "Chart", "chartType": "bar", "title": "Signups", "xLabel": "Week",
         "categories": ["W1", "W2"], "series": [{"name": "Web", "values": [12, 18.0]}, {"name": "iOS", "values": [4, 6.5]}]},
        {"id": "pie", "component": "Chart", "chartType": "pie", "title": "Share",
         "segments": [{"label": "Web", "value": 70}, {"label": "iOS", "value": 30}]},
    ]
    assert fallback_text(components) == "Signups\nWeek: W1, W2\nWeb: 12, 18\niOS: 4, 6.5\nShare\nWeb: 70\niOS: 30"


def test_a_line_chart_without_an_axis_label():
    chart = _root("Chart", chartType="line", title="Load", categories=["a", "b"], series=[{"name": "p95", "values": [1, 2]}])
    assert fallback_text([chart]) == "Load\na, b\np95: 1, 2"


def test_notice_without_a_title_and_inputs_by_label():
    components = [
        _root("Column", children=["note", "name", "bound"]),
        {"id": "note", "component": "Notice", "tone": "info", "text": "Heads up."},
        {"id": "name", "component": "TextField", "label": "Release name", "value": {"@path": "/name"}},
        {"id": "bound", "component": "Text", "text": {"@path": "/title"}},
    ]
    assert fallback_text(components) == "Heads up.\nRelease name"
