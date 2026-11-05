"""Surface validation: valid kit surfaces pass, and every limit and rule a2ui-core misses is ours."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from clawbits.a2ui.models import AgentSurfaceCreate
from clawbits.a2ui.validate import surface_errors

TOOL_SPEC = json.loads((Path(__file__).parents[2] / "clawbits/a2ui/tool_spec.json").read_text())
DESCRIPTION = TOOL_SPEC["tools"][0]["description"]
EXAMPLE = re.search(r"^Example: (.+)$", DESCRIPTION, re.M)[1]
CHOICE_MODEL, CHOICE = re.search(r"^Choice example, with dataModel (\{.*?\}): (.+)$", DESCRIPTION, re.M).groups()
FORM_MODEL, FORM_EXAMPLE = re.search(r"^Form example, with dataModel (\{.*?\}): (.+)$", DESCRIPTION, re.M).groups()


def _errors(components: list[dict], data_model: dict | None = None) -> list[dict]:
    surface = AgentSurfaceCreate(components=components, data_model=data_model or {})
    return surface_errors(surface.to_ui("post-1").a2ui)


def _ours(components: list[dict], data_model: dict | None = None) -> list[tuple[str, str]]:
    errors = _errors(components, data_model)
    assert all(e["version"] == "1.0" and e["error"]["surfaceId"] == "post-1" for e in errors)
    return [(e["error"]["code"], e["error"].get("path", "")) for e in errors]


def _root(component: str, **props) -> dict:
    return {"id": "root", "component": component, **props}


def _link(url: object) -> list[dict]:
    return [
        _root("Button", child="label", action={"functionCall": {"@call": "openUrl", "args": {"url": url}}}),
        {"id": "label", "component": "Text", "text": "Open"},
    ]


def _event(**event) -> list[dict]:
    return [
        _root("Button", child="label", action={"event": {"name": "deploy", **event}}),
        {"id": "label", "component": "Text", "text": "Deploy"},
    ]


def _chain(levels: int) -> list[dict]:
    ids = ["root", *(f"n{i}" for i in range(1, levels))]
    return [
        *({"id": a, "component": "Column", "children": [b]} for a, b in zip(ids, ids[1:], strict=False)),
        {"id": ids[-1], "component": "Text", "text": "leaf"},
    ]


STATUS_CARD = [
    _root("Card", child="body"),
    {"id": "body", "component": "Column", "children": ["title", "stats", "row", "hosts", "note", "kv", "runs"]},
    {"id": "title", "component": "Text", "text": "Deploy health", "accessibility": {"label": "Title", "live": "polite"}},
    {"id": "stats", "component": "Stats", "items": [{"label": "Uptime", "value": "99.98", "unit": "%", "trend": "up"}]},
    {"id": "row", "component": "Row", "children": ["docs", "rule"], "justify": "spaceBetween"},
    {"id": "docs", "component": "Button", "child": "label", "variant": "borderless",
     "action": {"functionCall": {"@call": "openUrl", "args": {"url": "https://example.com/runs?week=45#top"}}}},
    {"id": "rule", "component": "Divider"},
    {"id": "hosts", "component": "Table", "caption": "Hosts", "headers": ["Host", "CPU"], "rows": [["s1", 42], ["s2", 77.5]],
     "rowHeaderColumnIndex": 0},
    {"id": "note", "component": "Notice", "tone": "warn", "title": "s2 is warm", "text": "CPU above 75%."},
    {"id": "kv", "component": "KeyValue", "items": [{"label": "Region", "value": "eu-west"}]},
    {"id": "runs", "component": "StatusList", "items": [{"title": "api v2.4.1", "subtitle": "3 min ago", "tone": "ok"}]},
    {"id": "label", "component": "Text", "text": "All runs"},
]
CHARTS = [
    _root("Column", children=["bar", "pie"]),
    {"id": "bar", "component": "Chart", "chartType": "bar", "title": "Signups", "categories": ["W1", "W2"],
     "series": [{"name": "Web", "values": [12, 18]}, {"name": "iOS", "values": [4, 6]}], "xLabel": "Week"},
    {"id": "pie", "component": "Chart", "chartType": "pie", "title": "Share",
     "segments": [{"label": "Web", "value": 70}, {"label": "iOS", "value": 30}]},
]
FORM = [
    _root("Column", children=["name", "go"]),
    {"id": "name", "component": "TextField", "label": "Name", "value": {"@path": "/form/name"},
     "checks": [{"condition": {"@call": "required", "args": {"value": {"@path": "/form/name"}}}, "message": "Required"}]},
    {"id": "go", "component": "Button", "child": "go_label", "action": {"event": {"name": "go", "userMessage": "Go",
     "context": {"name": {"@path": "/form/name"}}}}},
    {"id": "go_label", "component": "Text", "text": "Go"},
]


@pytest.mark.parametrize(
    ("components", "data_model"),
    [
        (json.loads(EXAMPLE), None),
        (json.loads(CHOICE), json.loads(CHOICE_MODEL)),
        (json.loads(FORM_EXAMPLE), json.loads(FORM_MODEL)),
        (STATUS_CARD, None),
        (CHARTS, None),
        (FORM, {"form": {"name": ""}}),
    ],
    ids=["tool spec example", "tool spec choice example", "tool spec form example", "status card", "charts", "form"],
)
def test_valid_surfaces_pass(components, data_model):
    assert _errors(components, data_model) == []


def test_component_count_is_one_to_a_hundred():
    texts = [{"id": f"t{i}", "component": "Text", "text": "x"} for i in range(100)]
    with pytest.raises(ValidationError):
        AgentSurfaceCreate(components=[])
    with pytest.raises(ValidationError):
        AgentSurfaceCreate(components=[_root("Column", children=[t["id"] for t in texts]), *texts])


def test_a_surface_is_at_most_32_kb():
    texts = [{"id": f"t{i}", "component": "Text", "text": "x" * 1990} for i in range(17)]
    assert _ours([_root("Column", children=[t["id"] for t in texts]), *texts]) == [("VALIDATION_FAILED", "")]


def test_strings_are_at_most_2000_characters():
    long = "x" * 2001
    assert _ours([_root("Text", text=long)]) == [("VALIDATION_FAILED", "/components/0/text")]
    assert _ours([_root("Text", text="ok")], {"note": long}) == [("VALIDATION_FAILED", "/dataModel/note")]


def test_depth_is_capped_at_seven():
    assert _errors(_chain(8)) == []
    assert _ours(_chain(9)) == [("RECURSION_LIMIT_EXCEEDED", "")]


@pytest.mark.parametrize(
    "component",
    [
        _root("KeyValue", items=[{"label": "a", "value": "1"}] * 17),
        _root("Stats", items=[{"label": "a", "value": "1"}] * 7),
        _root("StatusList", items=[{"title": "a", "tone": "ok"}] * 31),
        _root("Table", caption="c", headers=["a"], rows=[["1"]] * 51),
        _root("Table", caption="c", headers=[str(i) for i in range(13)], rows=[[str(i) for i in range(13)]]),
        _root("Chart", chartType="bar", title="t", categories=["a"], series=[{"name": "s", "values": [1]}] * 5),
        _root("Chart", chartType="line", title="t", categories=[str(i) for i in range(61)],
              series=[{"name": "s", "values": list(range(61))}]),
        _root("Notice", tone="loud", text="x"),
        _root("Notice", tone="ok", text={"@path": "/x"}),
    ],
    ids=["keyvalue 17", "stats 7", "statuslist 31", "table 51 rows", "table 13 columns", "chart 5 series",
         "chart 61 points", "unknown tone", "bound literal-only prop"],
)
def test_catalog_limits_hold(component):
    assert [code for code, _ in _ours([component])] == ["VALIDATION_FAILED"]


def test_unknown_props_are_refused():
    assert _ours([_root("Text", text="hi", color="red", size=3)]) == [
        ("VALIDATION_FAILED", "/components/0/color"),
        ("VALIDATION_FAILED", "/components/0/size"),
    ]


def test_checks_only_on_checkable_components():
    check = [{"condition": {"@call": "required", "args": {"value": "x"}}}]
    assert _ours([_root("Text", text="hi", checks=check)]) == [("VALIDATION_FAILED", "/components/0/checks")]


@pytest.mark.parametrize(
    "accessibility",
    [{"lable": "x"}, {"label": 3}, {"live": "loud"}, {"hidden": "yes"}, "label"],
)
def test_accessibility_shape(accessibility):
    assert _errors([_root("Text", text="hi", accessibility={"label": {"@path": "/a"}, "hidden": True})]) == []
    assert _ours([_root("Text", text="hi", accessibility=accessibility)]) == [
        ("VALIDATION_FAILED", "/components/0/accessibility")
    ]


@pytest.mark.parametrize(
    "url",
    ["http://example.com", "/runs", "https://", "https://user@example.com", "https://exa mple.com",
     "javascript:alert(1)", {"@path": "/url"}],
)
def test_open_url_takes_a_literal_absolute_https_url(url):
    assert _ours(_link(url)) == [("VALIDATION_FAILED", "/components/0/action/functionCall")]


def test_open_url_is_only_a_button_action():
    call = {"@call": "openUrl", "args": {"url": "https://example.com"}}
    assert _ours([_root("Text", text=call)]) == [("VALIDATION_FAILED", "/components/0/text")]
    email = [
        _root("Button", child="label", action={"functionCall": {"@call": "email", "args": {"value": "a@b.co"}}}),
        {"id": "label", "component": "Text", "text": "Check"},
    ]
    assert _ours(email) == [("VALIDATION_FAILED", "/components/0/action/functionCall")]


def test_user_message_is_literal():
    assert _errors(_event(userMessage="Deploying")) == []
    assert _ours(_event(userMessage={"@path": "/msg"})) == [
        ("VALIDATION_FAILED", "/components/0/action/event/userMessage")
    ]


@pytest.mark.parametrize(
    ("props", "path"),
    [
        ({"chartType": "pie", "categories": ["a"], "segments": [{"label": "a", "value": 1}]}, "/components/0"),
        ({"chartType": "pie"}, "/components/0"),
        ({"chartType": "bar", "categories": ["a"]}, "/components/0"),
        ({"chartType": "area", "segments": [{"label": "a", "value": 1}]}, "/components/0"),
        ({"chartType": "line", "categories": ["a", "b"], "series": [{"name": "s", "values": [1]}]},
         "/components/0/series/0/values"),
    ],
)
def test_chart_cross_field_rules(props, path):
    assert _ours([_root("Chart", title="t", **props)]) == [("VALIDATION_FAILED", path)]


def test_table_rows_are_as_wide_as_headers():
    table = {"caption": "c", "headers": ["a", "b"]}
    assert _ours([_root("Table", **table, rows=[["1", "2"], ["3"]])]) == [("VALIDATION_FAILED", "/components/0/rows/1")]
    assert _ours([_root("Table", **table, rows=[["1", "2"]], rowHeaderColumnIndex=2)]) == [
        ("VALIDATION_FAILED", "/components/0/rowHeaderColumnIndex")
    ]


def test_a2ui_core_errors_pass_through():
    assert _ours([{"id": "top", "component": "Text", "text": "x"}]) == [("INTEGRITY_ERROR", "")]
    assert _ours([_root("Column", children=["ghost"])]) == [("INTEGRITY_ERROR", "")]
    assert _ours([_root("Video", url="https://x.co")]) == [("VALIDATION_FAILED", "/components/0/component")]


def test_a_component_has_one_parent():
    shared = [
        _root("Column", children=["a", "b"]),
        {"id": "a", "component": "Column", "children": ["t"]},
        {"id": "b", "component": "Column", "children": ["t"]},
        {"id": "t", "component": "Text", "text": "x"},
    ]
    assert _ours(shared) == [("VALIDATION_FAILED", "/components/2")]


def test_list_templates_are_refused():
    template = [_root("Column", children={"componentId": "t", "path": "/items"}), {"id": "t", "component": "Text", "text": "x"}]
    assert ("VALIDATION_FAILED", "/components/0/children") in _ours(template, {"items": [1]})


def test_a_button_is_labelled_by_a_text():
    nested = [
        _root("Button", child="inner", action={"event": {"name": "a"}}),
        {"id": "inner", "component": "Button", "child": "label", "action": {"event": {"name": "b"}}},
        {"id": "label", "component": "Text", "text": "x"},
    ]
    assert _ours(nested) == [("VALIDATION_FAILED", "/components/0/child")]


def test_numbers_are_finite():
    table = _root("Table", caption="c", headers=["a"], rows=[[float("nan")]])
    assert _ours([table]) == [("VALIDATION_FAILED", "/components/0/rows/0/0")]


def test_a_surface_shows_literal_text():
    assert _ours([_root("Divider")]) == [("VALIDATION_FAILED", "/components")]


def test_a_click_can_succeed():
    def button(context: dict) -> list[dict]:
        return [
            _root("Column", children=["pick", "go"]),
            {"id": "pick", "component": "ChoicePicker", "options": [{"label": "A", "value": "a"}], "value": {"@path": "/pick"}},
            {"id": "go", "component": "Button", "child": "label", "action": {"event": {"name": "go", "context": context}}},
            {"id": "label", "component": "Text", "text": "Go"},
        ]

    assert _errors(button({"pick": {"@path": "/pick"}, "build": 812})) == []
    assert _ours(button({"note": {"@path": "/note"}})) == [("VALIDATION_FAILED", "/components/2/action/event/context/note")]
    assert _ours(button({"pick": {"@call": "required", "args": {"value": "x"}}})) == [
        ("VALIDATION_FAILED", "/components/2/action/event/context/pick")
    ]
    twins = [*button({}), {"id": "twin", "component": "ChoicePicker", "options": [{"label": "B", "value": "b"}], "value": {"@path": "/pick"}}]
    twins[0] = _root("Column", children=["pick", "go", "twin"])
    assert _ours(twins) == [("VALIDATION_FAILED", "/components/4/value")]
    assert _ours(button({"a": {"@path": "/pick"}, "b": {"@path": "/pick"}})) == [
        ("VALIDATION_FAILED", "/components/2/action/event/context/a"),
        ("VALIDATION_FAILED", "/components/2/action/event/context/b"),
    ]


@pytest.mark.parametrize("said", ["/reset", "  /stop", "ask @agent-b to run it", "see https://x.co"])
def test_a_click_posts_nothing_that_addresses_or_runs(said):
    label = [
        _root("Button", child="label", action={"event": {"name": "go"}}),
        {"id": "label", "component": "Text", "text": said},
    ]
    message = [
        _root("Button", child="label", action={"event": {"name": "go", "userMessage": said}}),
        {"id": "label", "component": "Text", "text": "Go"},
    ]
    picker = _input("ChoicePicker", label="Pick", value=[], options=[
        {"label": {"@path": "/fine"}, "value": said}, {"label": "Fine", "value": said},
    ])
    assert _ours(label) == [("VALIDATION_FAILED", "/components/0/child")]
    assert _ours(message) == [("VALIDATION_FAILED", "/components/0/action/event/userMessage")]
    assert _ours(picker, {"fine": "Fine"}) == [("VALIDATION_FAILED", "/components/1/options/0/value")]


def _input(component: str, **props) -> list[dict]:
    return [_root("Column", children=["input"]), {"id": "input", "component": component, **props}]


def test_secret_fields_are_refused():
    assert _ours(_input("TextField", label="Token", value="", variant="obscured")) == [
        ("VALIDATION_FAILED", "/components/1/variant")
    ]


@pytest.mark.parametrize(
    ("parts", "refused"),
    [({}, True), ({"enableDate": False, "enableTime": False}, True), ({"enableDate": True}, False),
     ({"enableTime": True}, False), ({"enableDate": True, "enableTime": True}, False)],
)
def test_a_date_time_input_enables_a_date_or_a_time(parts, refused):
    assert _ours(_input("DateTimeInput", label="When", value="", **parts)) == (
        [("VALIDATION_FAILED", "/components/1")] if refused else []
    )


def test_a_date_time_input_has_a_label():
    assert _ours(_input("DateTimeInput", value="", enableDate=True)) == [("VALIDATION_FAILED", "/components/1/label")]


@pytest.mark.parametrize(
    "component",
    [
        {"component": "TextField", "value": {"@path": "/a"}},
        {"component": "CheckBox", "value": False},
        {"component": "DateTimeInput", "value": "", "enableDate": True},
        {"component": "ChoicePicker", "value": [], "options": [{"label": "A", "value": "a"}]},
    ],
    ids=["text field", "check box", "date time input", "choice picker"],
)
@pytest.mark.parametrize("label", ["/reset", "ask @agent-b", "see https://x.co"])
def test_input_labels_post_nothing_that_addresses_or_runs(component, label):
    assert _ours(_input(**component, label=label)) == [("VALIDATION_FAILED", "/components/1/label")]


def test_data_model_strings_post_nothing_that_addresses_or_runs():
    field = _input("TextField", label="Name", value={"@path": "/form/name"})
    assert _ours(field, {"form": {"name": "@agent-b"}, "tags": ["ok", " /stop"]}) == [
        ("VALIDATION_FAILED", "/dataModel/form/name"),
        ("VALIDATION_FAILED", "/dataModel/tags/1"),
    ]


def test_bound_context_keys_post_nothing_that_addresses_or_runs():
    form = [
        _root("Column", children=["name", "go"]),
        {"id": "name", "component": "TextField", "label": {"@path": "/label"}, "value": {"@path": "/name"}},
        {"id": "go", "component": "Button", "child": "go_label",
         "action": {"event": {"name": "go", "context": {"ask @agent-b": {"@path": "/name"}, "/literal": 1}}}},
        {"id": "go_label", "component": "Text", "text": "Go"},
    ]
    assert _ours(form) == [("VALIDATION_FAILED", "/components/2/action/event/context/ask @agent-b")]


@pytest.mark.parametrize(
    ("condition", "refused"),
    [
        ({"@path": "/a"}, False),
        ({"@call": "required", "args": {"value": {"@path": "/a"}}}, False),
        ({"@call": "length", "args": {"value": "abc", "min": 1, "max": 5}}, False),
        ({"@call": "email", "args": {"value": {"@path": "/a"}}}, False),
        ({"@call": "@index"}, True),
        ({"@call": "required", "args": {"value": {"@call": "email", "args": {"value": "a@b.co"}}}}, True),
    ],
    ids=["path", "required", "length", "email", "a system function", "a nested call"],
)
def test_a_check_is_a_path_or_a_check_function(condition, refused):
    field = _input("TextField", label="Name", value={"@path": "/a"}, checks=[{"condition": condition, "message": "Fix it."}])
    assert _ours(field) == ([("VALIDATION_FAILED", "/components/1/checks/0/condition")] if refused else [])


@pytest.mark.parametrize(
    ("index", "condition", "refused"),
    [
        (1, {"@path": "/name"}, False),
        (1, {"@call": "required", "args": {"value": {"@path": "/agree"}}}, True),
        (3, {"@call": "length", "args": {"value": {"@path": "/name"}, "max": 9}}, False),
        (3, {"@path": "/agree"}, True),
    ],
    ids=["a field's own value", "another input's value", "a pointer the click sends", "one it does not send"],
)
def test_a_check_reads_only_what_its_click_sends(index, condition, refused):
    form = [
        _root("Column", children=["name", "agree", "go"]),
        {"id": "name", "component": "TextField", "label": "Name", "value": {"@path": "/name"}},
        {"id": "agree", "component": "CheckBox", "label": "Agree", "value": {"@path": "/agree"}},
        {"id": "go", "component": "Button", "child": "go_label",
         "action": {"event": {"name": "go", "context": {"name": {"@path": "/name"}}}}},
        {"id": "go_label", "component": "Text", "text": "Go"},
    ]
    form[index] |= {"checks": [{"condition": condition}]}
    assert _ours(form) == ([("VALIDATION_FAILED", f"/components/{index}/checks/0/condition")] if refused else [])


WHEN = {"component": "DateTimeInput", "label": "When", "enableDate": True, "enableTime": True}
NOTIFY = {"component": "CheckBox", "label": "Notify"}
SEATS = {"component": "TextField", "label": "Seats", "variant": "number"}
TARGET = {"component": "ChoicePicker", "label": "Target", "options": [{"label": "A", "value": "a"}]}


@pytest.mark.parametrize(
    ("component", "start", "refused"),
    [
        (NOTIFY, None, False),
        (NOTIFY, False, False),
        (NOTIFY, "no", True),
        (SEATS, "3", False),
        (SEATS, 3, True),
        (TARGET, ["a"], False),
        (TARGET, "a", True),
        (WHEN, "2026-11-04T18:30", False),
        (WHEN, "tomorrow", True),
        (WHEN, "2026-11-04T18:30+02:00", True),
        (WHEN, "2026-11-04T18:30:15", True),
    ],
)
def test_a_starting_value_shows_what_an_untouched_click_sends(component, start, refused):
    field = _input(**component, value={"@path": "/v"})
    assert _ours(field, {"v": start}) == ([("VALIDATION_FAILED", "/dataModel/v")] if refused else [])


def test_an_undated_input_starts_at_nothing_but_empty():
    field = _input("DateTimeInput", label="When", value={"@path": "/v"})
    assert _ours(field, {"v": "2026-11-04"}) == [("VALIDATION_FAILED", "/dataModel/v"), ("VALIDATION_FAILED", "/components/1")]
