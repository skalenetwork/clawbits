"""Git repository API endpoints for agents.

Agents can create repos and commits in organizations that own them.
All operations go through JSON API; no native git protocol is exposed.
"""
import logging

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader
from sqlmodel import Session

from clawbits.datastructures.git_models import (
    BlobResponse,
    CommitListResponse,
    CommitResponse,
    CreateCommitRequest,
    CreateRepoRequest,
    RepoListResponse,
    RepoResponse,
    TreeEntryResponse,
    TreeResponse,
)
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.email.imap_client import agent_email_address
from clawbits.fastapi.agent_auth import extract_agent, require_own_agent
from clawbits.gas.cost_decorator import cost
from clawbits.git import repo_manager

api_key_header = APIKeyHeader(name="Authorization", auto_error=False)

logger = logging.getLogger(__name__)


class GitEndpoints:
    """Git repository endpoint implementations.

    Each static method receives the ``ClawBitsServer`` instance as first arg.
    """

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_agent(server, api_key: str):
        return extract_agent(server._engine, api_key)

    @staticmethod
    def _require_own_agent(agent, agent_id: str):
        require_own_agent(agent, agent_id)

    @staticmethod
    def _resolve_org(server, agent_id: str, org_id: str | None) -> str:
        """Resolve org_id: if None, use the agent's bound org. Verify agent is in org."""
        with Session(server._engine) as db:
            if org_id is None:
                org_id = TableRead.get_agent_org_id(db, agent_id)
                if org_id is None:
                    raise HTTPException(status_code=400, detail="Agent has no organization. Specify org_id.")
            if not TableRead.is_agent_in_org(db, agent_id, org_id):
                raise HTTPException(status_code=403, detail=f"Agent is not associated with organization '{org_id}'")
        return org_id

    @staticmethod
    def _get_base_path(server) -> str:
        return getattr(server, "_git_repos_base_path", repo_manager.GIT_REPOS_BASE_PATH)

    @staticmethod
    def _find_repo(server, agent_id: str, repo_name: str) -> dict:
        """Find a repo by name across all orgs that own this agent."""
        with Session(server._engine) as db:
            repos = TableRead.get_repos_for_agent(db, agent_id)
        for r in repos:
            if r["name"] == repo_name:
                return r
        raise HTTPException(status_code=404, detail=f"Repository '{repo_name}' not found")

    # ------------------------------------------------------------------
    # POST /api/agentic/agents/{agent_id}/repos
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def create_repo(
        server,
        agent_id: str,
        body: CreateRepoRequest,
        api_key: str = Security(api_key_header),
    ) -> RepoResponse:
        """Create a new git repository in an organization that owns this agent."""
        try:
            agent = GitEndpoints._extract_agent(server, api_key)
            GitEndpoints._require_own_agent(agent, agent_id)

            org_id = GitEndpoints._resolve_org(server, agent_id, body.org_id)
            base_path = GitEndpoints._get_base_path(server)

            # Check name uniqueness
            with Session(server._engine) as db:
                existing = TableRead.get_repo_by_org_and_name(db, org_id, body.name)
            if existing:
                raise HTTPException(status_code=409, detail=f"Repository '{body.name}' already exists in this organization")

            import uuid
            repo_id = f"repo-{uuid.uuid4()}"

            # Init git repo on disk
            author_email = agent_email_address(agent_id)
            repo_manager.init_repo(base_path, org_id, body.name, author_name=agent_id, author_email=author_email)

            # Store in DB
            with Session(server._engine) as db:
                TableWrite.create_repository(
                    db, repo_id, org_id, body.name, body.description, agent_id,
                )
                db.commit()

            with Session(server._engine) as db:
                repo = TableRead.get_repository(db, repo_id)

            return RepoResponse(**repo)

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error creating repo: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/repos
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def list_repos(
        server,
        agent_id: str,
        api_key: str = Security(api_key_header),
    ) -> RepoListResponse:
        """List repositories accessible to this agent."""
        try:
            agent = GitEndpoints._extract_agent(server, api_key)
            GitEndpoints._require_own_agent(agent, agent_id)

            with Session(server._engine) as db:
                repos = TableRead.get_repos_for_agent(db, agent_id)

            return RepoListResponse(
                repositories=[RepoResponse(**r) for r in repos],
                total=len(repos),
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing repos: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/repos/{repo_name}/commits
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def list_commits(
        server,
        agent_id: str,
        repo_name: str,
        api_key: str = Security(api_key_header),
        branch: str = "main",
        limit: int = 50,
        offset: int = 0,
    ) -> CommitListResponse:
        """List commits in a repository."""
        try:
            agent = GitEndpoints._extract_agent(server, api_key)
            GitEndpoints._require_own_agent(agent, agent_id)
            repo = GitEndpoints._find_repo(server, agent_id, repo_name)

            base_path = GitEndpoints._get_base_path(server)
            commits = repo_manager.list_commits(base_path, repo["org_id"], repo_name, branch, limit, offset)
            total = repo_manager.count_commits(base_path, repo["org_id"], repo_name, branch)

            return CommitListResponse(
                commits=[CommitResponse(**c) for c in commits],
                total=total,
                repo_name=repo_name,
                branch=branch,
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing commits: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/repos/{repo_name}/tree
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def list_tree(
        server,
        agent_id: str,
        repo_name: str,
        api_key: str = Security(api_key_header),
        ref: str = "main",
        path: str = "",
    ) -> TreeResponse:
        """List files/directories in a repository tree."""
        try:
            agent = GitEndpoints._extract_agent(server, api_key)
            GitEndpoints._require_own_agent(agent, agent_id)
            repo = GitEndpoints._find_repo(server, agent_id, repo_name)

            base_path = GitEndpoints._get_base_path(server)
            entries = repo_manager.list_tree(base_path, repo["org_id"], repo_name, ref, path)

            return TreeResponse(
                entries=[TreeEntryResponse(**e) for e in entries],
                total=len(entries),
                repo_name=repo_name,
                path=path or "/",
                ref=ref,
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error listing tree: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # GET /api/agentic/agents/{agent_id}/repos/{repo_name}/blob/{file_path:path}
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def read_blob(
        server,
        agent_id: str,
        repo_name: str,
        file_path: str,
        api_key: str = Security(api_key_header),
        ref: str = "main",
    ) -> BlobResponse:
        """Read file content from a repository."""
        try:
            agent = GitEndpoints._extract_agent(server, api_key)
            GitEndpoints._require_own_agent(agent, agent_id)
            repo = GitEndpoints._find_repo(server, agent_id, repo_name)

            base_path = GitEndpoints._get_base_path(server)
            content = repo_manager.read_blob(base_path, repo["org_id"], repo_name, ref, file_path)
            if content is None:
                raise HTTPException(status_code=404, detail=f"File '{file_path}' not found at ref '{ref}'")

            return BlobResponse(
                path=file_path,
                content=content,
                size=len(content.encode("utf-8")),
                repo_name=repo_name,
                ref=ref,
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error reading blob: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    # ------------------------------------------------------------------
    # POST /api/agentic/agents/{agent_id}/repos/{repo_name}/commits
    # ------------------------------------------------------------------

    @staticmethod
    @cost(1)
    def create_commit(
        server,
        agent_id: str,
        repo_name: str,
        body: CreateCommitRequest,
        api_key: str = Security(api_key_header),
    ) -> CommitResponse:
        """Create a commit with file changes."""
        try:
            agent = GitEndpoints._extract_agent(server, api_key)
            GitEndpoints._require_own_agent(agent, agent_id)
            repo = GitEndpoints._find_repo(server, agent_id, repo_name)

            base_path = GitEndpoints._get_base_path(server)
            author_email = agent_email_address(agent_id)

            # Enforce 64 KB per-file size limit for create/update actions
            max_file_size = 64 * 1024  # 64 KB
            for f in body.files:
                if (
                    f.action in ("create", "update")
                    and f.content is not None
                    and len(f.content.encode("utf-8")) > max_file_size
                ):
                        raise HTTPException(
                            status_code=413,
                            detail=f"File too large: {f.path} is {len(f.content.encode('utf-8'))} bytes (max: {max_file_size} bytes)"
                        )

            files = [{"path": f.path, "content": f.content, "action": f.action} for f in body.files]
            try:
                result = repo_manager.create_commit(
                    base_path, repo["org_id"], repo_name,
                    body.message, files,
                    author_name=agent_id, author_email=author_email,
                    branch=body.branch,
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Invalid file path: {e}")
            if result is None:
                raise HTTPException(status_code=500, detail="Failed to create commit")

            return CommitResponse(**result)

        except HTTPException:
            raise
        except Exception as e:
            logger.exception(f"Error creating commit: {e}")
            raise HTTPException(status_code=500, detail=str(e))

