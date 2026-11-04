"""A click checked against its stored surface: the server builds the v1.0 action and its post's text
from the component, takes from the client only the values of bound context keys, checks each by its
input and the surface's checks, and a closing click keeps the values in the card."""
from __future__ import annotations

import pytest

from clawbits.a2ui.models import AgentSurfaceCreate, PostUi, UiAction, UiActionRequest
from clawbits.a2ui.validate import build_action, closed_by, surface_errors


def _button(button_id: str, label: str | dict, checks: list[dict] | None = None, **event) -> list[dict]:
    button = {"id": button_id, "component": "Button", "child": f"{button_id}_label", "action": {"event": event}}
    return [
        button | ({"checks": checks} if checks else {}),
        {"id": f"{button_id}_label", "component": "Text", "text": label},
    ]


SURFACE = [
    {"id": "root", "component": "Column", "children": ["ask", "env", "regions", "go", "ship", "cancel", "docs"]},
    {"id": "ask", "component": "Text", "text": "Deploy where?"},
    {
        "id": "env",
        "component": "ChoicePicker",
        "options": [{"label": "Staging", "value": "staging"}, {"label": "Production", "value": "production"}],
        "value": {"@path": "/env"},
    },
    {
        "id": "regions",
        "component": "ChoicePicker",
        "variant": "multipleSelection",
        "options": [{"label": "EU", "value": "eu"}, {"label": {"@path": "/us"}, "value": "us"}],
        "value": {"@path": "/regions"},
    },
    *_button("go", "Deploy", name="deploy", context={"env": {"@path": "/env"}, "regions": {"@path": "/regions"}, "build": 812}),
    *_button("ship", "Ship", name="ship", userMessage="Ship it", context={"build": 812}),
    *_button("cancel", {"@path": "/cancel"}, name="cancel"),
    {
        "id": "docs",
        "component": "Button",
        "child": "docs_label",
        "action": {"functionCall": {"@call": "openUrl", "args": {"url": "https://example.com"}}},
    },
    {"id": "docs_label", "component": "Text", "text": "Docs"},
]
UI = AgentSurfaceCreate(components=SURFACE, data_model={"env": [], "regions": []}).to_ui("post-7")


def _build(source: str, bound: dict | None = None) -> tuple[UiAction, str] | list[dict]:
    return build_action(UI, UiActionRequest(rev=0, source_component_id=source, bound=bound or {}, client_key="k"))


def _problem_path(source: str, bound: dict | None = None) -> str:
    problems = _build(source, bound)
    assert isinstance(problems, list) and len(problems) == 1
    return problems[0]["error"]["path"]


def test_the_surface_is_valid():
    assert surface_errors(UI.a2ui) == []


def test_picks_follow_the_label_and_literals_stay_as_stored():
    action, message = _build("go", {"env": ["production"], "regions": ["us", "eu"]})

    assert message == "Deploy\nenv: Production\nregions: us, EU"
    assert action.timestamp.endswith("Z")
    assert action.model_dump(exclude={"timestamp"}) == {
        "name": "deploy",
        "surfaceId": "post-7",
        "sourceComponentId": "go",
        "userMessage": None,
        "context": {"env": ["production"], "regions": ["us", "eu"], "build": 812},
    }


def test_no_picks_is_the_label_alone():
    assert _build("go", {"env": [], "regions": []})[1] == "Deploy"


def test_one_shown_value_follows_the_label():
    assert _build("go", {"env": ["staging"], "regions": []})[1] == "Deploy: Staging"
    assert _build("go", {"env": [], "regions": ["eu"]})[1] == "Deploy: EU"


def test_user_message_wins_then_label_then_name():
    action, message = _build("ship")
    assert (message, action.user_message, action.context) == ("Ship it", "Ship it", {"build": 812})
    assert _build("cancel")[1] == "cancel"


@pytest.mark.parametrize("source", ["ask", "env", "docs", "nope"])
def test_the_source_is_a_button_with_an_event(source):
    problems = _build(source)
    assert problems == [
        {
            "version": "1.0",
            "error": {
                "code": "VALIDATION_FAILED",
                "surfaceId": "post-7",
                "path": "/sourceComponentId",
                "message": "sourceComponentId names a Button with an event action.",
            },
        }
    ]


@pytest.mark.parametrize(
    ("bound", "path"),
    [
        ({"env": []}, "/bound"),
        ({"env": [], "regions": [], "build": 1}, "/bound"),
        ({"env": "staging", "regions": []}, "/bound/env"),
        ({"env": ["qa"], "regions": []}, "/bound/env"),
        ({"env": [{"value": "staging"}], "regions": []}, "/bound/env"),
        ({"env": ["staging", "production"], "regions": []}, "/bound/env"),
        ({"env": [], "regions": ["eu", "eu"]}, "/bound/regions"),
    ],
    ids=["a missing key", "a forged literal", "not a list", "not an option", "not a string", "two on a mutually exclusive picker", "a repeated pick"],
)
def test_bound_values_are_the_pickers_options(bound, path):
    assert _problem_path("go", bound) == path


def test_a_closed_surface_keeps_its_rev_moving():
    closed = UI.closed_with("Chose: staging")
    assert (closed.rev, closed.closed.text) == (1, "Chose: staging")
    assert PostUi.model_validate(closed.model_dump()) == closed


def test_nothing_picked_is_an_empty_pick():
    action, said = _build("go", {"env": None, "regions": []})
    assert said == "Deploy"
    assert action.context == {"env": [], "regions": [], "build": 812}


def _field(field_id: str, component: str, label: str | dict, **props) -> dict:
    return {"id": field_id, "component": component, "label": label, "value": {"@path": f"/form/{field_id}"}, **props}


def _call(name: str, path: str = "/field", **args) -> dict:
    return {"condition": {"@call": name, "args": {"value": {"@path": path}, **args}}}


BOOKING = {
    "when": "2026-11-05T09:30:00+02:00",
    "updates": None,
    "name": "Ada",
    "email": "ada@example.com",
    "seats": "3",
    "notes": "",
    "agree": True,
    "day": "2026-11-05",
    "at": "09:30:15",
}
FORM = [
    {
        "id": "root",
        "component": "Column",
        "children": ["name", "email", "seats", "notes", "agree", "updates", "day", "at", "when", "book", "save"],
    },
    _field("name", "TextField", "Name", checks=[_call("required", "/form/name"), _call("length", "/form/name", max=20)]),
    _field("email", "TextField", "Email", checks=[_call("email", "/form/email")]),
    _field("seats", "TextField", {"@path": "/seatsLabel"}, variant="number"),
    _field("notes", "TextField", "Notes", variant="longText"),
    _field("agree", "CheckBox", "I agree"),
    _field("updates", "CheckBox", "Send updates"),
    _field("day", "DateTimeInput", "Day", enableDate=True),
    _field("at", "DateTimeInput", "At", enableTime=True),
    _field("when", "DateTimeInput", "When", enableDate=True, enableTime=True),
    *_button(
        "book", "Book", [{"condition": {"@path": "/form/agree"}, "message": "Accept the terms."}], name="book",
        context={key: {"@path": f"/form/{key}"} for key in BOOKING} | {"room": 4},
    ),
    *_button("save", "Save", name="save", context={"name": {"@path": "/form/name"}}),
]
FORM_MODEL = {
    "form": {"name": "", "email": "", "seats": "", "notes": "", "agree": False, "updates": False, "day": "", "at": "", "when": ""},
    "seatsLabel": "Seats",
}
FORM_UI = AgentSurfaceCreate(components=FORM, data_model=FORM_MODEL).to_ui("post-9")
BOOKED = {
    "name": "Name: Ada",
    "email": "Email: ada@example.com",
    "seats": "seats: 3",
    "notes": None,
    "agree": "I agree: yes",
    "updates": "Send updates: no",
    "day": "Day: 2026-11-05",
    "at": "At: 09:30",
    "when": "When: 2026-11-05 09:30",
}


def _lines(said: str, lines: dict[str, str | None]) -> str:
    return "\n".join([said, *filter(None, lines.values())])


def _book(source: str = "book", **bound) -> tuple[UiAction, str] | list[dict]:
    values = BOOKING | bound if source == "book" else bound
    return build_action(FORM_UI, UiActionRequest(rev=0, source_component_id=source, bound=values, client_key="k"))


def _failed(result: tuple[UiAction, str] | list[dict]) -> tuple[str, str] | None:
    if not isinstance(result, list):
        return None
    (problem,) = result
    return problem["error"]["path"], problem["error"]["message"]


def test_the_form_is_valid():
    assert surface_errors(FORM_UI.a2ui) == []


def test_a_form_posts_a_line_per_value_in_the_order_of_its_inputs():
    action, message = _book()

    assert message == _lines("Book", BOOKED)
    assert action.context == BOOKING | {"updates": False, "room": 4}


def test_one_value_is_said_after_the_label():
    action, message = _book("save", name="Ada")
    assert (message, action.context) == ("Save: Ada", {"name": "Ada"})


@pytest.mark.parametrize(
    ("key", "value", "line"),
    [
        ("notes", "line one\nline two", "Notes: line one\nline two"),
        ("notes", None, None),
        ("seats", "-2.50", "seats: -2.50"),
        ("seats", "-.5e3", "seats: -.5e3"),
        ("seats", "", None),
        ("at", "09:30", "At: 09:30"),
        ("at", "24:00", "At: 24:00"),
        ("when", "2026-11-05T09:30", "When: 2026-11-05 09:30"),
        ("when", "2026-11-05T09:30Z", "When: 2026-11-05 09:30"),
        ("when", "2026-11-05T23:59:59-05:00", "When: 2026-11-05 23:59"),
        ("when", "", None),
        ("day", None, None),
        ("email", "", None),
    ],
)
def test_each_input_takes_its_kind_of_value(key, value, line):
    action, message = _book(**{key: value})
    assert action.context[key] == ("" if value is None else value)
    assert message == _lines("Book", BOOKED | {key: line})


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("name", 3),
        ("name", "Ada\nLovelace"),
        ("name", "x" * 2001),
        ("email", []),
        ("seats", "3."),
        ("seats", "1e"),
        ("seats", "\u0663"),
        ("seats", "3\n"),
        ("notes", 5),
        ("agree", "true"),
        ("agree", 1),
        ("day", "2026-11-5"),
        ("day", "2026-02-30"),
        ("day", "20261105"),
        ("day", "2026-11-05T09:30"),
        ("at", "9:30"),
        ("at", "25:00"),
        ("at", "12:60"),
        ("at", "09:30Z"),
        ("at", "09:30:00.5"),
        ("when", "2026-11-05"),
        ("when", "2026-11-05 09:30"),
        ("when", "2026-11-05T09:30+2:00"),
        ("when", "2026-11-05T09:30+25:00"),
        ("when", "2026-11-05T09:30:00.123Z"),
    ],
)
def test_bound_values_hold_their_inputs_kind(key, value):
    path, message = _failed(_book(**{key: value}))
    assert path == f"/bound/{key}"
    assert message.startswith(f"{key} holds ")


def _first_failure(field_checks: list[dict], button_checks: list[dict] | None = None, **bound) -> str | None:
    components = [
        {"id": "root", "component": "Column", "children": ["field", "box", "pick", "go"]},
        {"id": "field", "component": "TextField", "variant": "longText", "label": "Field", "value": {"@path": "/field"},
         "checks": field_checks},
        {"id": "box", "component": "CheckBox", "label": "Box", "value": {"@path": "/box"}},
        {"id": "pick", "component": "ChoicePicker", "options": [{"label": "A", "value": "a"}], "value": {"@path": "/pick"}},
        *_button("go", "Go", button_checks, name="go", context={key: {"@path": f"/{key}"} for key in ("field", "box", "pick")}),
    ]
    ui = AgentSurfaceCreate(components=components).to_ui("post-3")
    assert surface_errors(ui.a2ui) == []
    bound = {"field": "", "box": None, "pick": []} | bound
    failed = _failed(build_action(ui, UiActionRequest(rev=0, source_component_id="go", bound=bound, client_key="k")))
    return failed and failed[1]


@pytest.mark.parametrize(
    ("check", "field", "failure"),
    [
        (_call("required"), "x", None),
        (_call("required"), "  \t", "Required."),
        (_call("required"), None, "Required."),
        (_call("required"), "\ufeff", "Required."),
        (_call("required"), "\x1f", None),
        (_call("length", min=2, max=3), "a", "Use at least 2 characters."),
        (_call("length", min=2, max=3), "\U0001f99e\U0001f99e\U0001f99e", None),
        (_call("length", max=3), "abcd", "Use at most 3 characters."),
        (_call("email"), "", None),
        (_call("email"), "ada@example.com", None),
        (_call("email"), "ada@example", "Enter an email address."),
        (_call("email"), "ada lovelace@example.com", "Enter an email address."),
        (_call("email"), "ada@example.com\n", "Enter an email address."),
        (_call("email") | {"message": "Use your work email."}, "ada@", "Use your work email."),
    ],
)
def test_field_checks_run_on_the_bound_value(check, field, failure):
    assert _first_failure([check], field=field) == failure


@pytest.mark.parametrize(
    ("check", "bound", "failure"),
    [
        ({"condition": {"@path": "/box"}}, {"box": True}, None),
        ({"condition": {"@path": "/box"}}, {"box": False}, "Check this field."),
        ({"condition": {"@path": "/box"}, "message": "Tick the box."}, {"box": None}, "Tick the box."),
        (_call("required", "/box"), {"box": False}, None),
        (_call("required", "/pick"), {"pick": []}, "Required."),
        (_call("required", "/pick"), {"pick": ["a"]}, None),
    ],
)
def test_button_checks_run_on_the_data_model_with_the_bound_values(check, bound, failure):
    assert _first_failure([], [check], **bound) == failure


def test_the_first_failing_check_answers():
    checks = [_call("length", min=5), _call("email"), _call("required")]
    assert _first_failure(checks, field="a@b") == "Use at least 5 characters."
    assert _first_failure([_call("required")], [{"condition": {"@path": "/box"}}]) == "Check this field."


def test_a_forged_click_that_skips_the_checks_is_refused():
    assert _failed(_book(name="")) == ("/bound/name", "Required.")
    assert _failed(_book(email="ada")) == ("/bound/email", "Enter an email address.")
    assert _failed(_book(agree=False)) == ("/sourceComponentId", "Accept the terms.")
    assert _failed(_book(name="x" * 21)) == ("/bound/name", "Use at most 20 characters.")


def test_a_post_is_at_most_40000_characters():
    keys = [f"f{i}" for i in range(21)]
    components = [
        {"id": "root", "component": "Column", "children": [*keys, "go"]},
        *(_field(key, "TextField", key.upper(), variant="longText") for key in keys),
        *_button("go", "Go", name="go", context={key: {"@path": f"/form/{key}"} for key in keys}),
    ]
    ui = AgentSurfaceCreate(components=components).to_ui("post-4")
    request = UiActionRequest(rev=0, source_component_id="go", bound=dict.fromkeys(keys, "x" * 2000), client_key="k")

    assert _failed(build_action(ui, request)) == ("/bound", "A click posts at most 40000 characters.")
    assert isinstance(build_action(ui, request.model_copy(update={"bound": dict.fromkeys(keys, "x" * 1800)})), tuple)


def test_a_closing_click_keeps_its_values_in_the_card():
    action, message = _book()

    closed = closed_by(FORM_UI, action, message)

    assert (closed.rev, closed.closed.text) == (1, "Book")
    assert closed.a2ui.create_surface.data_model == {"form": BOOKING | {"updates": False}, "seatsLabel": "Seats"}
    assert FORM_UI.a2ui.create_surface.data_model == FORM_MODEL
    assert closed.a2ui.create_surface.components == FORM
    assert closed_by(FORM_UI, *_book("save", name="Ada")).closed.text == "Save: Ada"


@pytest.mark.parametrize(
    ("path", "data_model", "written"),
    [
        ("/draft/text", {}, {"draft": {"text": "hi"}}),
        ("/lines/0", {"lines": ["old", "kept"]}, {"lines": ["hi", "kept"]}),
        ("/lines/2", {"lines": ["old", "kept"]}, {"lines": ["old", "kept"]}),
        ("/fixed/text", {"fixed": "literal"}, {"fixed": "literal"}),
        ("/unset/text", {"unset": None}, {"unset": None}),
        ("/unset", {"unset": None}, {"unset": "hi"}),
        ("/a~1b", {}, {"a/b": "hi"}),
    ],
)
def test_a_value_is_written_where_an_input_writes_it(path, data_model, written):
    components = [
        {"id": "root", "component": "Column", "children": ["note", "go"]},
        {"id": "note", "component": "TextField", "label": "Note", "value": {"@path": path}},
        *_button("go", "Go", name="go", context={"note": {"@path": path}}),
    ]
    ui = AgentSurfaceCreate(components=components, data_model=data_model).to_ui("post-5")
    action, message = build_action(ui, UiActionRequest(rev=0, source_component_id="go", bound={"note": "hi"}, client_key="k"))

    assert closed_by(ui, action, message).a2ui.create_surface.data_model == written
