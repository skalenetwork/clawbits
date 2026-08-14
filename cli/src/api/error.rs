//! Turning server failures into something a person can act on.

use std::fmt;

use serde_json::Value;

#[derive(Debug)]
pub enum ApiError {
    /// HTTP 401 — every caller wants the same follow-up, so `main` appends the
    /// sign-in hint once rather than each command remembering to.
    Unauthorized(String),
    Forbidden(String),
    NotFound(String),
    Status {
        code: u16,
        detail: String,
    },
    /// DNS, TLS, connection refused, timeout.
    Transport(String),
    /// A 2xx body that didn't match the expected shape. Carries the path so a
    /// schema drift names the endpoint that drifted.
    Decode {
        path: String,
        source: serde_json::Error,
    },
}

impl ApiError {
    pub fn from_status(code: u16, body: &str) -> Self {
        let detail = flatten_detail(body);
        match code {
            401 => ApiError::Unauthorized(detail),
            403 => ApiError::Forbidden(detail),
            404 => ApiError::NotFound(detail),
            _ => ApiError::Status { code, detail },
        }
    }

    /// Documented in `--help`; scripts depend on these.
    pub fn exit_code(&self) -> i32 {
        match self {
            ApiError::Unauthorized(_) => 3,
            ApiError::Forbidden(_) => 4,
            ApiError::NotFound(_) => 5,
            ApiError::Transport(_) => 6,
            ApiError::Status { .. } | ApiError::Decode { .. } => 1,
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Unauthorized(d) => write!(f, "not signed in (401: {d})"),
            ApiError::Forbidden(d) => write!(f, "forbidden (403: {d})"),
            // No status prefix: this variant is also raised for a name that
            // resolves to nothing client-side, where there was no 404 to cite.
            // The detail is self-describing either way.
            ApiError::NotFound(d) => write!(f, "{d}"),
            ApiError::Status { code, detail } => write!(f, "server returned {code}: {detail}"),
            ApiError::Transport(e) => write!(f, "could not reach the server: {e}"),
            ApiError::Decode { path, source } => {
                write!(f, "unexpected response shape from {path}: {source}")
            }
        }
    }
}

impl std::error::Error for ApiError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ApiError::Decode { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Flatten a FastAPI error body into one human-readable line.
///
/// Clawbits wraps every `HTTPException` in a global handler, so the envelope is
/// `{"error": true, "status_code": .., "detail": .., "path": ..}`. Inside it,
/// `detail` takes three different shapes:
///
/// 1. a string — the common `HTTPException(detail="Not a member of this channel")`;
/// 2. a **list** of `{loc, msg, type}` — Pydantic's 422. Not an edge case here:
///    the messaging request models are `extra="forbid"` with length limits, so
///    this is what a too-long message or a stray field produces;
/// 3. an object — used by some structured error paths, e.g. the 426
///    `plugin_outdated` payload.
///
/// A non-JSON body (an HTML error page from a proxy in front of the app) falls
/// back to the trimmed text.
///
/// Note there is never a `Retry-After` to read: the global handler drops
/// `exc.headers`, so rate-limit hints are inlined in `detail` instead.
pub fn flatten_detail(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return truncate(body.trim());
    };

    let detail = value
        .get("detail")
        .or_else(|| value.get("message"))
        .unwrap_or(&value);

    match detail {
        Value::String(s) => truncate(s),
        Value::Array(items) => {
            let joined = items
                .iter()
                .map(format_validation_item)
                .collect::<Vec<_>>()
                .join("; ");
            truncate(&joined)
        }
        Value::Object(map) => {
            // Structured errors carry the useful sentence under `message`.
            if let Some(Value::String(m)) = map.get("message") {
                truncate(m)
            } else {
                truncate(&detail.to_string())
            }
        }
        Value::Null => truncate(body.trim()),
        other => truncate(&other.to_string()),
    }
}

/// `{"loc": ["body", "message"], "msg": "...", "type": "..."}` → `body.message: ...`
fn format_validation_item(item: &Value) -> String {
    let loc = item
        .get("loc")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .map(|p| match p {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
                .join(".")
        })
        .unwrap_or_default();
    let msg = item
        .get("msg")
        .and_then(Value::as_str)
        .unwrap_or("invalid value");
    if loc.is_empty() {
        msg.to_string()
    } else {
        format!("{loc}: {msg}")
    }
}

/// An HTML error page would otherwise dump a screenful into the terminal.
fn truncate(s: &str) -> String {
    const MAX: usize = 500;
    let s = s.trim();
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_string_detail() {
        let body = r#"{"error":true,"status_code":403,"detail":"Not a member of this channel","path":"/x"}"#;
        assert_eq!(flatten_detail(body), "Not a member of this channel");
    }

    #[test]
    fn pydantic_validation_list() {
        // What you actually get for an over-long message: the mm request
        // models are extra="forbid" with max_length constraints.
        let body = r#"{"detail":[{"loc":["body","message"],"msg":"String should have at most 4000 characters","type":"string_too_long"}]}"#;
        assert_eq!(
            flatten_detail(body),
            "body.message: String should have at most 4000 characters"
        );
    }

    #[test]
    fn multiple_validation_items_are_joined() {
        let body = r#"{"detail":[
            {"loc":["body","message"],"msg":"field required"},
            {"loc":["body","nope"],"msg":"extra fields not permitted"}
        ]}"#;
        assert_eq!(
            flatten_detail(body),
            "body.message: field required; body.nope: extra fields not permitted"
        );
    }

    #[test]
    fn structured_object_detail_prefers_message() {
        let body = r#"{"detail":{"code":"plugin_outdated","message":"This endpoint requires the openclaw plugin >= 0.7.1."}}"#;
        assert_eq!(
            flatten_detail(body),
            "This endpoint requires the openclaw plugin >= 0.7.1."
        );
    }

    #[test]
    fn object_without_message_is_still_readable() {
        let body = r#"{"detail":{"code":"weird"}}"#;
        assert!(flatten_detail(body).contains("weird"));
    }

    #[test]
    fn non_json_body_falls_back_to_text() {
        // A proxy in front of the app, not the app itself.
        assert_eq!(flatten_detail("  502 Bad Gateway  "), "502 Bad Gateway");
    }

    #[test]
    fn empty_body_does_not_panic() {
        assert_eq!(flatten_detail(""), "");
    }

    #[test]
    fn oversized_detail_is_truncated() {
        let long = "x".repeat(5000);
        let out = flatten_detail(&long);
        assert!(
            out.chars().count() <= 501,
            "got {} chars",
            out.chars().count()
        );
        assert!(out.ends_with('…'));
    }

    #[test]
    fn status_maps_to_variant_and_exit_code() {
        let cases = [
            (401u16, 3i32),
            (403, 4),
            (404, 5),
            (400, 1),
            (409, 1),
            (422, 1),
            (500, 1),
        ];
        for (code, expected) in cases {
            let err = ApiError::from_status(code, r#"{"detail":"nope"}"#);
            assert_eq!(err.exit_code(), expected, "status {code}");
        }
        assert!(matches!(
            ApiError::from_status(401, "{}"),
            ApiError::Unauthorized(_)
        ));
        assert_eq!(ApiError::Transport("refused".into()).exit_code(), 6);
    }
}
