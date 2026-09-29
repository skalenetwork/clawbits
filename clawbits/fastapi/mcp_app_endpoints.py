"""The frame an MCP App view renders in: its stored ``ui://`` document under the CSP its server declared, in an
opaque origin that reaches nothing of ours. Public by content hash, and served only into iframes."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request
from fastapi.responses import HTMLResponse

from clawbits.datastructures.mm_models import McpAppCsp
from clawbits.db.models import McpAppResource
from clawbits.fastapi.human_endpoints import _get_db

mcp_app_router = APIRouter(tags=["MCP Apps"])


def _frame_policy(csp: McpAppCsp) -> str:
    resources = csp.resource_domains
    directives = {
        "default-src": ("'none'",),
        "script-src": ("'unsafe-inline'", *resources),
        "style-src": ("'unsafe-inline'", *resources),
        "img-src": ("data:", "blob:", *resources),
        "font-src": ("data:", *resources),
        "media-src": ("data:", "blob:", *resources),
        "connect-src": csp.connect_domains or ("'none'",),
        "frame-src": csp.frame_domains or ("'none'",),
        "base-uri": csp.base_uri_domains or ("'none'",),
        "form-action": ("'none'",),
    }
    return "; ".join(["sandbox allow-scripts", *(f"{name} {' '.join(src)}" for name, src in directives.items())])


@mcp_app_router.get("/api/mcp-apps/{resource}", include_in_schema=False)
def mcp_app_frame(request: Request, resource: Annotated[str, Path(pattern=r"^[0-9a-f]{64}$")]) -> HTMLResponse:
    if request.headers.get("sec-fetch-dest") != "iframe":
        raise HTTPException(status_code=404)
    with _get_db(request) as db:
        row = db.get(McpAppResource, resource)
        if row is None:
            raise HTTPException(status_code=404)
        return HTMLResponse(row.html, headers={"Content-Security-Policy": _frame_policy(McpAppCsp.model_validate(row.csp))})
