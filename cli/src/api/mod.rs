//! The HTTP client.
//!
//! # Auth
//!
//! One header, everywhere: `Authorization: Bearer <session token>`. Clawbits'
//! human auth dependency resolves the dev-auth token first and the sealed
//! WorkOS session second, and *both* prefer the bearer header over the cookie,
//! so a single code path covers a local dev server and the hosted app. No
//! cookie jar, no CSRF token, no Origin header — none of it is checked.
//!
//! # Version headers, deliberately absent
//!
//! `X-Clawbits-Plugin-Version` / `-Kind` are not sent. The server treats a
//! missing version as supported, and the 426 gate only sits on agent routes
//! anyway. Sending a kind would opt this CLI into a version floor belonging to
//! some other client for no benefit.
//!
//! # Session rotation
//!
//! A sealed WorkOS session rotates when its access token expires, and the new
//! value comes back only as a `Set-Cookie`. A bearer client that ignores it
//! keeps presenting a token that eventually stops refreshing. So every response
//! is scanned for a rotated session cookie and the new value is stashed in
//! `rotated` for `main` to persist.

pub mod auth;
pub mod error;
pub mod mm;
pub mod orgs;

use std::cell::RefCell;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;

pub use error::ApiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

pub struct RawResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub struct Client {
    agent: ureq::Agent,
    base_url: String,
    token: Option<String>,
    verbose: bool,
    rotated: RefCell<Option<String>>,
}

/// Attach the headers every request carries. A macro rather than a function
/// because ureq's builder is two distinct types — `RequestBuilder<WithBody>`
/// and `RequestBuilder<WithoutBody>` — with no shared trait to hang this on.
macro_rules! decorate {
    ($client:expr, $req:expr) => {{
        let mut r = $req.header("Accept", "application/json");
        if let Some(token) = &$client.token {
            r = r.header("Authorization", &format!("Bearer {token}"));
        }
        r
    }};
}

impl Client {
    pub fn new(base_url: &str, token: Option<String>, timeout: Duration, verbose: bool) -> Self {
        let config = ureq::Agent::config_builder()
            // Cloudflare's managed rules block generic clients — the Python
            // agent CLI carries a note about `Python-urllib/*` being refused.
            // Overridable so a deployment behind a stricter WAF can adapt
            // without a rebuild.
            .user_agent(
                std::env::var("CLAWBITS_USER_AGENT")
                    .unwrap_or_else(|_| concat!("clawbits-cli/", env!("CARGO_PKG_VERSION")).into()),
            )
            .timeout_global(Some(timeout))
            // ureq's default turns any 4xx/5xx into Error::StatusCode and
            // discards the body — which is exactly where `detail` lives.
            .http_status_as_error(false)
            .build();

        Self {
            agent: config.into(),
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
            verbose,
            rotated: RefCell::new(None),
        }
    }

    /// A rotated session token, if the server issued one during this run.
    pub fn take_rotated_token(&self) -> Option<String> {
        self.rotated.borrow_mut().take()
    }

    pub fn execute(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<RawResponse, ApiError> {
        let url = format!("{}{}", self.base_url, path);

        let result = match method {
            Method::Get => {
                let mut r = decorate!(self, self.agent.get(&url));
                for (k, v) in query {
                    r = r.query(*k, v);
                }
                r.call()
            }
            Method::Delete => {
                let mut r = decorate!(self, self.agent.delete(&url));
                for (k, v) in query {
                    r = r.query(*k, v);
                }
                r.call()
            }
            Method::Post => {
                let mut r = decorate!(self, self.agent.post(&url));
                for (k, v) in query {
                    r = r.query(*k, v);
                }
                send_body(r, body)
            }
            Method::Put => {
                let mut r = decorate!(self, self.agent.put(&url));
                for (k, v) in query {
                    r = r.query(*k, v);
                }
                send_body(r, body)
            }
            Method::Patch => {
                let mut r = decorate!(self, self.agent.patch(&url));
                for (k, v) in query {
                    r = r.query(*k, v);
                }
                send_body(r, body)
            }
        };

        let mut response = result.map_err(|e| ApiError::Transport(e.to_string()))?;
        let status = response.status().as_u16();

        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or("<binary>").to_string(),
                )
            })
            .collect();

        self.capture_rotated_session(&headers);

        if self.verbose {
            eprintln!("{} {} -> {}", method.as_str(), path, status);
        }

        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|e| ApiError::Transport(format!("reading response body: {e}")))?;

        Ok(RawResponse {
            status,
            headers,
            body,
        })
    }

    /// `execute` plus status and JSON handling. Returns `Value::Null` for an
    /// empty body (204s are common here).
    pub fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value, ApiError> {
        let resp = self.execute(method, path, query, body)?;
        if !(200..300).contains(&resp.status) {
            return Err(ApiError::from_status(resp.status, &resp.body));
        }
        if resp.body.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&resp.body).map_err(|source| ApiError::Decode {
            path: path.to_string(),
            source,
        })
    }

    /// Typed convenience. Deserialization happens on top of the `Value` rather
    /// than off the wire so `--json` can print exactly what the server sent,
    /// even fields this binary doesn't model yet.
    pub fn request_as<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<T, ApiError> {
        let value = self.request(method, path, query, body)?;
        serde_json::from_value(value).map_err(|source| ApiError::Decode {
            path: path.to_string(),
            source,
        })
    }

    pub fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        self.request(Method::Get, path, query, None)
    }

    pub fn get_as<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, ApiError> {
        self.request_as(Method::Get, path, query, None)
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        self.request(Method::Post, path, &[], Some(body))
    }

    pub fn post_as<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T, ApiError> {
        self.request_as(Method::Post, path, &[], Some(body))
    }

    fn capture_rotated_session(&self, headers: &[(String, String)]) {
        for (name, value) in headers {
            if !name.eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            if let Some(token) = rotated_session_from_cookie(value) {
                *self.rotated.borrow_mut() = Some(token);
            }
        }
    }
}

fn send_body(
    req: ureq::RequestBuilder<ureq::typestate::WithBody>,
    body: Option<&Value>,
) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
    match body {
        Some(v) => req.send_json(v),
        None => req.send_empty(),
    }
}

/// Pull a refreshed session token out of a `Set-Cookie` value.
///
/// The cookie name is environment-dependent — the server suffixes it (`_dev`,
/// `_staging`, …) so a developer's browser can hold sessions for two
/// deployments at once — so this matches on prefix rather than an exact name.
/// An empty value means a deletion (that's how logout clears them) and must not
/// be mistaken for a new token.
fn rotated_session_from_cookie(header: &str) -> Option<String> {
    let pair = header.split(';').next()?.trim();
    let (name, value) = pair.split_once('=')?;
    let name = name.trim();
    if !(name.starts_with("fc_session") || name.starts_with("fc_dev_session")) {
        return None;
    }
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Percent-encode one path segment.
///
/// Channel ids and agent ids go straight into paths. They are well-behaved
/// today, but a name-shaped id containing `/` or `?` would otherwise rewrite
/// the request target rather than 404.
pub fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_only_what_it_must() {
        assert_eq!(encode_segment("c_abc-123.def~x"), "c_abc-123.def~x");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
        assert_eq!(encode_segment("a b"), "a%20b");
        assert_eq!(encode_segment("a?b=c"), "a%3Fb%3Dc");
        assert_eq!(encode_segment("../etc"), "..%2Fetc");
        assert_eq!(encode_segment("café"), "caf%C3%A9");
    }

    #[test]
    fn recognises_a_rotated_session_cookie() {
        assert_eq!(
            rotated_session_from_cookie("fc_session=abc123; Path=/; HttpOnly; Secure"),
            Some("abc123".into())
        );
        // Env-suffixed names are the norm outside production.
        assert_eq!(
            rotated_session_from_cookie("fc_session_dev=xyz; Path=/"),
            Some("xyz".into())
        );
        assert_eq!(
            rotated_session_from_cookie("fc_dev_session_staging=q; Path=/"),
            Some("q".into())
        );
    }

    #[test]
    fn ignores_deletions_and_unrelated_cookies() {
        // Logout clears by setting an empty value — not a new token.
        assert_eq!(
            rotated_session_from_cookie("fc_session=; Path=/; Max-Age=0"),
            None
        );
        assert_eq!(
            rotated_session_from_cookie("fc_oauth_state=abc; Path=/"),
            None
        );
        assert_eq!(rotated_session_from_cookie("other=abc"), None);
        assert_eq!(rotated_session_from_cookie("garbage"), None);
        assert_eq!(rotated_session_from_cookie(""), None);
    }

    #[test]
    fn method_names_are_wire_accurate() {
        assert_eq!(Method::Get.as_str(), "GET");
        assert_eq!(Method::Patch.as_str(), "PATCH");
    }
}
