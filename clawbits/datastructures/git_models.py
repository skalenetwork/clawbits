"""Git repository data models for bot-managed repos."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

class CreateRepoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str = Field(
        min_length=1, max_length=64,
        pattern=r"^[a-z0-9][a-z0-9._-]*$",
        description="Repository name (lowercase, alphanumeric, dots, hyphens, underscores)",
    )
    description: str = Field(default="", max_length=256, description="Short description")
    org_id: str | None = Field(default=None, description="Organization ID (defaults to primary owner org)")


# A path segment: chars from [A-Za-z0-9._-] with at least one non-dot char,
# so "." and ".." never match. Anchored segments joined by "/" also exclude
# absolute paths, empty components, backslashes, and whitespace.
_PATH_SEGMENT = r"[A-Za-z0-9._-]*[A-Za-z0-9_-][A-Za-z0-9._-]*"


class FileChange(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    path: str = Field(
        min_length=1, max_length=512,
        pattern=rf"^{_PATH_SEGMENT}(/{_PATH_SEGMENT})*$",
        description="File path relative to repo root (segments of letters, digits, '.', '_', '-'; no absolute paths, no '.' or '..' segments)",
    )
    content: str | None = Field(default=None, description="File content (required for create/update)")
    action: Literal["create", "update", "delete"] = Field(description="Action to perform")


class CreateCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    message: str = Field(min_length=1, max_length=1000, description="Commit message")
    files: list[FileChange] = Field(min_length=1, max_length=100, description="File changes to commit")
    branch: str = Field(default="main", description="Branch to commit to")


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------

class RepoResponse(BaseModel):
    repo_id: str
    org_id: str
    org_name: str | None = None
    name: str
    description: str
    default_branch: str
    created_by_agent: str
    created_at: str


class RepoListResponse(BaseModel):
    repositories: list[RepoResponse]
    total: int


class CommitResponse(BaseModel):
    sha: str = Field(description="Commit SHA hash")
    message: str
    author_name: str
    author_email: str
    date: str


class CommitListResponse(BaseModel):
    commits: list[CommitResponse]
    total: int
    repo_name: str
    branch: str


class TreeEntryResponse(BaseModel):
    name: str = Field(description="File or directory name")
    path: str = Field(description="Full path relative to repo root")
    type: Literal["blob", "tree"] = Field(description="Entry type (blob=file, tree=directory)")
    size: int | None = Field(default=None, description="File size in bytes (only for blobs)")


class TreeResponse(BaseModel):
    entries: list[TreeEntryResponse]
    total: int
    repo_name: str
    path: str
    ref: str


class BlobResponse(BaseModel):
    path: str
    content: str
    size: int
    repo_name: str
    ref: str

