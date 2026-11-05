"""Surface validation: our size limit, then a2ui-core, then what a2ui-core misses; and a click
checked against its stored surface, with the checks both clients run.

Errors are A2UI v1.0 renderer error messages, so an agent reads ours and a2ui-core's alike.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Iterator
from datetime import date, datetime, time
from functools import partial, reduce
from typing import Any, NamedTuple

from a2ui.core import Catalog, MessageProcessor, MessageProcessorOptions, ValidationConfig

from clawbits.a2ui.fallback import fallback_text
from clawbits.a2ui.models import (
    CATALOG,
    SURFACE_TEXT_MAX_CHARS,
    A2uiEnvelope,
    PostUi,
    UiAction,
    UiActionRequest,
)

SURFACE_MAX_BYTES = 32 * 1024
SURFACE_MAX_DEPTH = 7
MESSAGE_MAX_CHARS = 40000

_CORE_CATALOG = Catalog.from_json(CATALOG)
_CORE_OPTIONS = MessageProcessorOptions(validation_config=ValidationConfig(max_depth=SURFACE_MAX_DEPTH))
_CHECKABLE = {"$ref": "common_types.json#/$defs/Checkable"}
_COMMON_KEYS = {"id", "catalogId", "accessibility", "metadata"}
_ACCESSIBILITY_KEYS = {"label", "description", "live", "hidden"}
_HTTPS_URL = re.compile(r"https://[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#]\S*)?")
_CHECK_CALLS = frozenset({"required", "length", "email"})
_JS_WHITESPACE = r"\t\n\v\f\r    -     　﻿"
_BLANK = re.compile(rf"[{_JS_WHITESPACE}]*")
_EMAIL = re.compile(rf"[^{_JS_WHITESPACE}@]+@[^{_JS_WHITESPACE}@]+\.[^{_JS_WHITESPACE}@]+")
_NUMBER = re.compile(r"-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?", re.ASCII)
_LINE_BREAK = re.compile(r"[\r\n]")
_INDEX = re.compile(r"0|[1-9]\d*", re.ASCII)
_DATE = r"\d{4}-\d{2}-\d{2}"
_TIME = r"\d{2}:\d{2}(?::\d{2})?"

Problems = Iterator[tuple[str, str]]


def _allowed_keys(schema: dict[str, Any]) -> frozenset[str]:
    parts = [schema, *schema.get("allOf", ())]
    keys = {key for part in parts for key in part.get("properties", {})} | _COMMON_KEYS
    return frozenset(keys | {"checks"} if _CHECKABLE in parts else keys)


_ALLOWED_KEYS = {name: _allowed_keys(schema) for name, schema in CATALOG["components"].items()}


def surface_errors(envelope: A2uiEnvelope) -> list[dict[str, Any]]:
    """Every problem with ``envelope``; empty when it is valid. Paths point into ``createSurface``.

    Our walks run after a2ui-core, which caps nesting at 50 levels: 32 KB of nested lists would
    otherwise recurse past Python's limit.
    """
    wire = envelope.model_dump()
    error = partial(_error, envelope.create_surface.surface_id)
    if len(json.dumps(wire, separators=(",", ":"), ensure_ascii=False).encode()) > SURFACE_MAX_BYTES:
        return [error("", f"A surface is at most {SURFACE_MAX_BYTES} bytes as JSON.")]
    if core := MessageProcessor([_CORE_CATALOG], options=_CORE_OPTIONS).process_messages_with_errors(wire):
        return core
    components = envelope.create_surface.components
    problems = [
        *(error(path, message) for path, message in _value_problems(wire["createSurface"])),
        *(error(path, message) for path, message in _structure_problems(components)),
        *(error(path, message) for path, message in _click_problems(components, wire["createSurface"]["dataModel"])),
        *(
            error(path, message)
            for index, component in enumerate(components)
            for path, message in _component_problems(component, f"/components/{index}")
        ),
    ]
    if not problems and not fallback_text(components).strip():
        problems.append(error("/components", "A surface shows some literal text."))
    return problems


def build_action(ui: PostUi, request: UiActionRequest) -> tuple[UiAction, str] | list[dict[str, Any]]:
    """The v1.0 ``action`` a click sends from ``ui``, and the action post's text; else problems,
    with paths into ``request``.

    The source is a Button with an event action, whose literal context values are kept as stored.
    ``bound`` holds exactly its ``@path``-bound keys, each an input's value, ``null`` read as that
    input's empty value. The Button's checks and those of each bound TextField then pass over
    ``dataModel`` with every bound value written. The text is the literal ``userMessage``, else the
    Button's label, else the event's name; then ": " and the one value shown, or a line
    ``Label: value`` per value shown, in the order the surface lists its inputs.
    """
    surface = ui.a2ui.create_surface
    error = partial(_error, surface.surface_id)
    components = {component["id"]: component for component in surface.components}
    source = components.get(request.source_component_id, {})
    event = source["action"].get("event") if source.get("component") == "Button" else None
    if event is None:
        return [error("/sourceComponentId", "sourceComponentId names a Button with an event action.")]
    context: dict[str, Any] = event.get("context", {})
    paths = _bound_paths(context)
    if request.bound.keys() != paths.keys():
        return [error("/bound", f"bound holds exactly the bound context keys: {', '.join(paths) or 'none'}.")]
    inputs = {
        path: component
        for component in surface.components
        if component["component"] in _INPUTS and (path := _bound_path(component["value"])) is not None
    }
    order = list(inputs)
    bound: dict[str, Any] = {}
    shown: list[tuple[str, str]] = []
    for key in sorted(paths, key=lambda name: order.index(paths[name])):
        component = inputs[paths[key]]
        kind = _INPUTS[component["component"]]
        value = kind.value_type() if request.bound[key] is None else request.bound[key]
        text = kind.shown(component, value) if isinstance(value, kind.value_type) else None
        if text is None:
            return [error(f"/bound/{_pointer(key)}", f"{key} holds {kind.holds.format(path=paths[key])}.")]
        bound[key] = value
        if text:
            label = component.get("label")
            shown.append(((label if isinstance(label, str) else "") or key, text))
    model = _written(surface.data_model, paths, bound)
    checked = {"/sourceComponentId": source} | {f"/bound/{_pointer(key)}": inputs[path] for key, path in paths.items()}
    for at, component in checked.items():
        if failures := _check_failures(component.get("checks", []), model):
            return [error(at, failures[0])]
    label = components[source["child"]]["text"]
    said = event.get("userMessage") or (label if isinstance(label, str) else "") or event["name"]
    lines = [said, *(f"{name}: {value}" for name, value in shown)]
    text = f"{said}: {shown[0][1]}" if len(shown) == 1 else "\n".join(lines)
    if len(text) > MESSAGE_MAX_CHARS:
        return [error("/bound", f"A click posts at most {MESSAGE_MAX_CHARS} characters.")]
    action = UiAction(
        name=event["name"],
        surface_id=surface.surface_id,
        source_component_id=request.source_component_id,
        user_message=event.get("userMessage"),
        context={key: bound.get(key, value) for key, value in context.items()},
    )
    return action, text


def closed_by(ui: PostUi, action: UiAction, text: str) -> PostUi:
    """``ui`` closed by ``action``, which ``build_action`` built from it with ``text``: ``closed.text``
    is the text's first line, and ``dataModel`` holds every bound value, so the closed card shows
    what was sent."""
    surface = ui.a2ui.create_surface
    source = next(component for component in surface.components if component["id"] == action.source_component_id)
    paths = _bound_paths(source["action"]["event"].get("context", {}))
    data_model = _written(surface.data_model, paths, action.context)
    envelope = A2uiEnvelope(create_surface=surface.model_copy(update={"data_model": data_model}))
    return ui.closed_with(text.partition("\n")[0]).model_copy(update={"a2ui": envelope})


def _check_failures(checks: list[dict[str, Any]], model: dict[str, Any]) -> list[str]:
    """The text of each of ``checks`` that fails over ``model``: its message, else the default."""
    return [
        check.get("message") or failure for check in checks if (failure := _failure(check["condition"], model))
    ]


def _failure(condition: dict[str, Any], model: dict[str, Any]) -> str | None:
    """The default text of ``condition`` failing over ``model``; ``None`` when it passes."""
    if (path := _bound_path(condition)) is not None:
        return None if _read(model, path) is True else "Check this field."
    args = {
        key: arg if (at := _bound_path(arg)) is None else _read(model, at) for key, arg in condition["args"].items()
    }
    value = args["value"]
    text = value if isinstance(value, str) else ""
    match condition["@call"]:
        case "required" if value is None or value == [] or (isinstance(value, str) and _BLANK.fullmatch(value)):
            return "Required."
        case "length" if len(text) < args.get("min", 0):
            return f"Use at least {args['min']} characters."
        case "length" if len(text) > args.get("max", len(text)):
            return f"Use at most {args['max']} characters."
        case "email" if text and not _EMAIL.fullmatch(text):
            return "Enter an email address."
    return None


def _picked(picker: dict[str, Any], values: list[Any]) -> str | None:
    """The labels of ``values`` picked in ``picker``; ``None`` unless that is a valid pick."""
    labels = {
        option["value"]: option["label"] if isinstance(option["label"], str) else option["value"]
        for option in picker["options"]
    }
    valid = (
        all(isinstance(value, str) and value in labels for value in values)
        and len(set(values)) == len(values)
        and (len(values) <= 1 or picker.get("variant") == "multipleSelection")
    )
    return ", ".join(labels[value] for value in values) if valid else None


def _typed(field: dict[str, Any], text: str) -> str | None:
    """``text`` as typed; ``None`` unless the TextField's variant holds it."""
    variant = field.get("variant", "shortText")
    valid = (
        len(text) <= SURFACE_TEXT_MAX_CHARS
        and (variant == "longText" or not _LINE_BREAK.search(text))
        and (variant != "number" or not text or _NUMBER.fullmatch(text) is not None)
    )
    return text if valid else None


def _checked(_box: dict[str, Any], checked: bool) -> str:
    return "yes" if checked else "no"


_MOMENTS: dict[tuple[bool, bool], tuple[re.Pattern[str], Callable[[str], object], int]] = {
    (True, False): (re.compile(_DATE, re.ASCII), date.fromisoformat, 10),
    (False, True): (re.compile(_TIME, re.ASCII), time.fromisoformat, 5),
    (True, True): (re.compile(rf"{_DATE}T{_TIME}(?:Z|[+-]\d{{2}}:\d{{2}})?", re.ASCII), datetime.fromisoformat, 16),
}


def _moment(field: dict[str, Any], value: str) -> str | None:
    """``value`` as shown, to the minute and without its offset, ``""`` when empty; ``None`` unless it
    is ISO 8601 of the parts ``field`` enables: a date, a time, or both with an optional UTC offset."""
    if not value:
        return ""
    if (moment := _MOMENTS.get((field.get("enableDate", False), field.get("enableTime", False)))) is None:
        return None
    shape, parse, width = moment
    if not shape.fullmatch(value):
        return None
    try:
        parse(value)
    except ValueError:
        return None
    return value.replace("T", " ")[:width]


class _Input(NamedTuple):
    """An input a click reads: its value's type, called for the empty value ``null`` stands for; the
    value as the post shows it, ``""`` for none and ``None`` when invalid; and what it holds."""
    value_type: type
    shown: Callable[[dict[str, Any], Any], str | None]
    holds: str


_INPUTS: dict[str, _Input] = {
    "ChoicePicker": _Input(
        list, _picked, "option values of the ChoicePicker at {path}, at most one unless it is multipleSelection"
    ),
    "TextField": _Input(
        str,
        _typed,
        f"text of at most {SURFACE_TEXT_MAX_CHARS} characters for the TextField at {{path}}, "
        "on one line unless it is longText, and a decimal number if it is number",
    ),
    "CheckBox": _Input(bool, _checked, "true or false for the CheckBox at {path}"),
    "DateTimeInput": _Input(str, _moment, '"" or ISO 8601 of the parts the DateTimeInput at {path} enables'),
}


def _value_problems(surface: dict[str, Any]) -> Problems:
    for path, node in _walk(surface, ""):
        if isinstance(node, str) and len(node) > SURFACE_TEXT_MAX_CHARS:
            yield path, f"Strings are at most {SURFACE_TEXT_MAX_CHARS} characters."
        elif isinstance(node, float) and not math.isfinite(node):
            yield path, "Numbers are finite."


_PLAIN = "A click posts this in the user's name, so it has no @ or link and does not start with /."


def _click_problems(components: list[dict[str, Any]], data_model: dict[str, Any]) -> Problems:
    """Clicks that can succeed, from an untouched card too, and whose text, posted as the user's
    message, addresses and runs nothing: Button labels and events, input labels, the option text a
    pick posts, context keys and every ``dataModel`` string."""
    by_id = {component["id"]: component for component in components}
    inputs: set[str] = set()
    for index, component in enumerate(components):
        if component["component"] not in _INPUTS:
            continue
        if not _plain(component.get("label")):
            yield f"/components/{index}/label", _PLAIN
        for option, choice in enumerate(component.get("options", ())):
            key = "label" if isinstance(choice["label"], str) else "value"
            if not _plain(choice[key]):
                yield f"/components/{index}/options/{option}/{key}", _PLAIN
        if (path := _bound_path(component["value"])) is None:
            continue
        if path in inputs:
            yield f"/components/{index}/value", f"Another input already keeps its value at {path}."
        inputs.add(path)
        start = _read(data_model, path)
        kind = _INPUTS[component["component"]]
        shown = kind.shown(component, start) if isinstance(start, kind.value_type) else None
        if start is not None and shown is None:
            yield f"/dataModel{path}", f"A starting value holds {kind.holds.format(path=path)}."
        elif isinstance(start, str) and component["component"] == "DateTimeInput" and shown != start.replace("T", " "):
            yield f"/dataModel{path}", "A starting date or time is to the minute, without a UTC offset."
    for path, node in _walk(data_model, "/dataModel"):
        if not _plain(node):
            yield path, _PLAIN
    for index, component in enumerate(components):
        event = component["action"].get("event") if component["component"] == "Button" else None
        if event is None:
            continue
        path = f"/components/{index}/action/event"
        if not _plain(by_id.get(component["child"], {}).get("text")):
            yield f"/components/{index}/child", _PLAIN
        for key in ("userMessage", "name"):
            if not _plain(event.get(key)):
                yield f"{path}/{key}", _PLAIN
        context = event.get("context", {})
        sent = list(_bound_paths(context).values())
        for key, value in context.items():
            if not isinstance(value, dict):
                continue
            at = f"{path}/context/{_pointer(key)}"
            if (bound := _bound_path(value)) not in inputs:
                yield at, "A context value is a literal or the @path of an input's value."
            elif sent.count(bound) > 1:
                yield at, f"Another context key also sends {bound}."
            elif not _plain(key):
                yield at, _PLAIN


def _plain(text: object) -> bool:
    return not isinstance(text, str) or not (text.lstrip().startswith("/") or "@" in text or "://" in text)


def _structure_problems(components: list[dict[str, Any]]) -> Problems:
    """A tree: one parent per component, children named by id, a Button labelled by a Text.

    a2ui-core allows shared children, which would let a small surface expand exponentially."""
    kinds = {component["id"]: component["component"] for component in components}
    parented: set[str] = set()
    for index, component in enumerate(components):
        path = f"/components/{index}"
        children = component.get("children", [component["child"]] if "child" in component else [])
        if not isinstance(children, list):
            yield f"{path}/children", "children is a list of component ids; list templates are not supported."
            continue
        for child in children:
            if child in parented:
                yield path, f"Component '{child}' has more than one parent."
            parented.add(child)
        if component["component"] == "Button" and kinds.get(component["child"]) != "Text":
            yield f"{path}/child", "A Button's child is a Text."


def _component_problems(component: dict[str, Any], path: str) -> Problems:
    name = component["component"]
    for key in sorted(component.keys() - _ALLOWED_KEYS[name]):
        yield f"{path}/{_pointer(key)}", f"{name} has no property '{key}'."
    if "accessibility" in component and not _accessible(component["accessibility"]):
        yield (
            f"{path}/accessibility",
            "accessibility takes label and description (text), live (off, polite or assertive) and "
            "hidden (true or false), each literal or bound with @path.",
        )
    for index, check in enumerate(component.get("checks", ())):
        if not _checkable(condition := check["condition"]):
            yield (
                f"{path}/checks/{index}/condition",
                "A check's condition is a @path, or a @call of required, length or email on literal or @path args.",
            )
        elif not _reads(condition) <= _sent(component):
            yield (
                f"{path}/checks/{index}/condition",
                "A TextField's checks read only its own value, and a Button's only the pointers its context sends.",
            )
    link = f"{path}/action/functionCall"
    for at, node in _walk(component, path):
        if isinstance(node, dict) and node.get("@call") == "openUrl" and not (name == "Button" and at == link):
            yield at, "openUrl is only a Button's action."
    if checks := _CROSS_FIELD.get(name):
        yield from checks(component, path)


def _button_problems(button: dict[str, Any], path: str) -> Problems:
    action = button["action"]
    if (call := action.get("functionCall")) is not None and not (
        call["@call"] == "openUrl" and isinstance(url := call["args"]["url"], str) and _HTTPS_URL.fullmatch(url)
    ):
        yield f"{path}/action/functionCall", "A Button's function call is openUrl with a literal absolute https url."
    if (event := action.get("event")) is not None and not isinstance(event.get("userMessage", ""), str):
        yield f"{path}/action/event/userMessage", "userMessage is literal text."


def _date_time_problems(field: dict[str, Any], path: str) -> Problems:
    if not (field.get("enableDate") or field.get("enableTime")):
        yield path, "A DateTimeInput enables a date, a time or both."


def _chart_problems(chart: dict[str, Any], path: str) -> Problems:
    if chart["chartType"] == "pie":
        if "segments" not in chart or "categories" in chart or "series" in chart:
            yield path, "A pie chart takes segments, and no categories or series."
        return
    if "segments" in chart or "categories" not in chart or "series" not in chart:
        yield path, "A bar, line or area chart takes categories and series, and no segments."
        return
    width = len(chart["categories"])
    for index, series in enumerate(chart["series"]):
        if len(series["values"]) != width:
            yield f"{path}/series/{index}/values", f"Each series has one value per category ({width})."


def _table_problems(table: dict[str, Any], path: str) -> Problems:
    width = len(table["headers"])
    for index, row in enumerate(table["rows"]):
        if len(row) != width:
            yield f"{path}/rows/{index}", f"Every row has one cell per header ({width})."
    if table.get("rowHeaderColumnIndex", 0) >= width:
        yield f"{path}/rowHeaderColumnIndex", f"rowHeaderColumnIndex names one of the {width} columns."


_CROSS_FIELD: dict[str, Callable[[dict[str, Any], str], Problems]] = {
    "Button": _button_problems,
    "Chart": _chart_problems,
    "DateTimeInput": _date_time_problems,
    "Table": _table_problems,
}


def _accessible(value: object) -> bool:
    return (
        isinstance(value, dict)
        and value.keys() <= _ACCESSIBILITY_KEYS
        and all(_dynamic(value[key], str) for key in ("label", "description") if key in value)
        and value.get("live", "off") in ("off", "polite", "assertive")
        and _dynamic(value.get("hidden", False), bool)
    )


def _checkable(condition: dict[str, Any]) -> bool:
    return "@path" in condition or (
        condition["@call"] in _CHECK_CALLS
        and not any(isinstance(arg, dict) and "@call" in arg for arg in condition["args"].values())
    )


def _reads(condition: dict[str, Any]) -> set[str]:
    """The pointers a check's condition reads: its own ``@path``, or its args'."""
    values = (condition, *condition.get("args", {}).values())
    return {path for value in values if (path := _bound_path(value)) is not None}


def _sent(component: dict[str, Any]) -> set[str]:
    """The pointers a click sends that ``component``'s checks may read: a Button's bound context, a
    TextField's own value."""
    if component["component"] == "Button":
        return set(_bound_paths((component["action"].get("event") or {}).get("context", {})).values())
    return {path} if (path := _bound_path(component.get("value"))) is not None else set()


def _bound_path(value: object) -> str | None:
    return value.get("@path") if isinstance(value, dict) else None


def _bound_paths(context: dict[str, Any]) -> dict[str, str]:
    """The ``@path`` of each bound key of an event's ``context``."""
    return {key: path for key, value in context.items() if (path := _bound_path(value)) is not None}


def _written(model: dict[str, Any], paths: dict[str, str], values: dict[str, Any]) -> dict[str, Any]:
    """``model`` with each of ``values`` written at its key's path, as an input writes it on the web:
    missing objects on the way are created; the root, or a path through a literal, ``null`` or past
    a list's end, leaves the model as it is."""
    for key, path in paths.items():
        if tokens := _tokens(path):
            model = _put(model, tokens, values[key])
    return model


def _put(at: object, tokens: list[str], value: object) -> object:
    if not tokens:
        return value
    key, *rest = tokens
    if isinstance(at, list):
        index = int(key) if _INDEX.fullmatch(key) else len(at)
        return [*at[:index], _put(at[index], rest, value), *at[index + 1 :]] if index < len(at) else at
    return {**at, key: _put(at.get(key, {}), rest, value)} if isinstance(at, dict) else at


def _read(model: dict[str, Any], path: str) -> object:
    """The value at a JSON Pointer in ``model``; ``None`` where there is none."""
    tokens = _tokens(path)
    return None if tokens is None else reduce(_step, tokens, model)


def _step(at: object, key: str) -> object:
    if isinstance(at, list):
        return at[int(key)] if _INDEX.fullmatch(key) and int(key) < len(at) else None
    return at.get(key) if isinstance(at, dict) else None


def _tokens(path: str) -> list[str] | None:
    """A JSON Pointer's reference tokens; ``None`` for a string that is not one."""
    head, *keys = path.split("/")
    return None if head else [key.replace("~1", "/").replace("~0", "~") for key in keys]


def _dynamic(value: object, literal: type) -> bool:
    return isinstance(value, literal) or (
        isinstance(value, dict) and value.keys() == {"@path"} and isinstance(value["@path"], str)
    )


def _walk(value: object, path: str) -> Iterator[tuple[str, object]]:
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _walk(child, f"{path}/{_pointer(key)}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk(child, f"{path}/{index}")


def _pointer(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def _error(surface_id: str, path: str, message: str) -> dict[str, Any]:
    return {
        "version": "1.0",
        "error": {"code": "VALIDATION_FAILED", "surfaceId": surface_id, "path": path, "message": message},
    }
