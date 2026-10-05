import json
import sys
import tomllib
from pathlib import Path

WRAP = "/etc/bench/wrap.sh"


def toml(value: object) -> str:
    match value:
        case dict():
            return "{ " + ", ".join(f"{json.dumps(k)} = {toml(v)}" for k, v in value.items()) + " }"
        case list():
            return "[" + ", ".join(map(toml, value)) + "]"
        case _:
            return json.dumps(value, ensure_ascii=False)


role = tomllib.loads(Path(sys.argv[1]).read_text())
ports = [
    f"REEF_PORT_{name.upper().replace('-', '_')}={port}"
    for name, port in role.pop("expose", {}).items()
]
role["name"] = "bench"
role["image"] = sys.argv[2] if len(sys.argv) > 2 else role["image"]
role["init"] = ["/usr/bin/env", *ports, "/bin/sh", WRAP, *role["init"]]
role["files"] = role.get("files", {}) | {WRAP: (Path(__file__).parent / "wrap.sh").read_text()}
print("\n".join(f"{json.dumps(k)} = {toml(v)}" for k, v in role.items()))
