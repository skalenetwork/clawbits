"""A surface as plain text: the post's ``message``, which search, previews, push, exports and agents
reading history see instead of the UI."""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def fallback_text(components: list[dict[str, Any]]) -> str:
    """Short, deterministic text read from ``root`` down. Expects a validated surface."""
    by_id = {component["id"]: component for component in components}

    def text(component_id: str) -> str:
        component = by_id[component_id]
        match component["component"]:
            case "Text":
                return _literal(component["text"])
            case "Column" | "Row":
                return _lines(map(text, component["children"]))
            case "Card":
                return text(component["child"])
            case "Button":
                label = text(component["child"])
                call = component["action"].get("functionCall")
                return f"{label} ({call['args']['url']})" if call else label
            case "Notice":
                return f"{component['title']}: {component['text']}" if component.get("title") else component["text"]
            case "KeyValue":
                return _lines(f"{item['label']}: {item['value']}" for item in component["items"])
            case "Stats":
                return _lines(_stat(item) for item in component["items"])
            case "StatusList":
                return _lines(
                    f"- {item['title']} ({item['subtitle']})" if item.get("subtitle") else f"- {item['title']}"
                    for item in component["items"]
                )
            case "Table":
                return _lines(
                    [
                        component["caption"],
                        " | ".join(component["headers"]),
                        *(" | ".join(map(_cell, row)) for row in component["rows"]),
                    ]
                )
            case "Chart":
                return _chart(component)
            case _:
                return _literal(component.get("label"))

    return text("root")


def _stat(item: dict[str, str]) -> str:
    unit = f" {item['unit']}" if item.get("unit") else ""
    delta = f" ({item['delta']})" if item.get("delta") else ""
    return f"{item['label']}: {item['value']}{unit}{delta}"


def _chart(chart: dict[str, Any]) -> str:
    if chart["chartType"] == "pie":
        data = [f"{segment['label']}: {_cell(segment['value'])}" for segment in chart["segments"]]
    else:
        categories = ", ".join(chart["categories"])
        data = [
            f"{chart['xLabel']}: {categories}" if chart.get("xLabel") else categories,
            *(f"{series['name']}: {', '.join(map(_cell, series['values']))}" for series in chart["series"]),
        ]
    return _lines([chart["title"], *data])


def _cell(value: str | float) -> str:
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def _literal(value: object) -> str:
    return value if isinstance(value, str) else ""


def _lines(parts: Iterable[str]) -> str:
    return "\n".join(part for part in parts if part)
