import inspect

from fastapi import HTTPException
from pydantic import ConfigDict

_STRICT = ConfigDict(strict=True)
def check_state(expression: bool, msg: str = "") -> None:
    """
    Raises LogicError if `expression` is False, formatting a message similar to the C++ macro.

    Example:
        check_state(x > 0, "x must be positive")
    """
    if expression:
        return

    caller = inspect.currentframe().f_back  # type: ignore[union-attr]
    info = inspect.getframeinfo(caller)

    func = caller.f_code.co_name if caller else "<unknown>"
    file = info.filename
    line = info.lineno

    expr_text = info.code_context[0].strip() if info.code_context else "<unknown>"

    base = f"Check failed::{expr_text} \n {file}:{line} {func}"
    detail = f"(): {msg}" if msg else "()"
    raise HTTPException(400, base + detail)


