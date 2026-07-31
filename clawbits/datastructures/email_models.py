"""Email inbox data models for agent email via Stalwart IMAP."""
from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

class EmailSendAttachment(BaseModel):
    """Attachment for an outgoing email."""
    filename: str
    content_b64: str = Field(description="Base64-encoded attachment content")


class EmailSendRequest(BaseModel):
    """Request body for sending an email to the agent's owner."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    subject: str = Field(min_length=1, max_length=256, description="Email subject line")
    message: str = Field(min_length=1, max_length=10000, description="Plain-text email body")
    attachments: list[EmailSendAttachment] = Field(default_factory=list, description="Optional attachments")
    headers: dict[str, str] = Field(default_factory=dict, description="Custom email headers")


class EmailAttachment(BaseModel):
    """A single email attachment."""
    filename: str
    content_type: str
    size: int
    content_b64: str | None = Field(default=None, description="Base64-encoded attachment content")


class EmailSetReadRequest(BaseModel):
    """Request body for setting a message's read state."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    is_read: bool = Field(description="Desired read state (the IMAP \\Seen flag)")


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------

class EmailSummaryResponse(BaseModel):
    """Summary of a single email (inbox listing)."""
    uid: int = Field(description="IMAP UID of the message")
    from_addr: str = Field(description="Sender address")
    to_addr: str = Field(description="Recipient address")
    subject: str = Field(description="Email subject line")
    date: str = Field(description="Date header value")
    is_read: bool = Field(description="Whether the message has been read (\\Seen flag)")
    size: int = Field(description="Message size in bytes")
    snippet: str | None = Field(
        default=None,
        description="Short plain-text preview of the body (~140 chars); None when unavailable (e.g. HTML-only mail on servers without PREVIEW)",
    )
    has_attachments: bool | None = Field(
        default=None,
        description="Whether the message carries attachments; None when unknown",
    )


class EmailDetailResponse(BaseModel):
    """Full detail of a single email including body."""
    uid: int
    from_addr: str
    to_addr: str
    subject: str
    date: str
    is_read: bool
    size: int
    body_text: str | None = Field(default=None, description="Plain-text body")
    body_html: str | None = Field(default=None, description="HTML body")
    attachments: list[EmailAttachment] = Field(default_factory=list, description="List of attachments")
    headers: dict[str, str] = Field(default_factory=dict, description="Full email headers")


class EmailListResponse(BaseModel):
    """Paginated list of emails."""
    emails: list[EmailSummaryResponse]
    total: int = Field(
        description="Total messages in the current view (mailbox total, or matching count when filtered with unread_only)"
    )
    unread_count: int = Field(description="Number of unread messages")
    limit: int
    offset: int


class EmailCountResponse(BaseModel):
    """Lightweight mailbox counts."""
    total: int
    unread: int
    email_address: str = Field(description="The agent's email address")


class EmailSendResponse(BaseModel):
    """Confirmation that an email was sent."""
    status: str = Field(description="Status of the send operation")
    from_addr: str = Field(description="Sender address")
    to_addr: str = Field(description="Recipient address")
    subject: str = Field(description="Email subject line")
