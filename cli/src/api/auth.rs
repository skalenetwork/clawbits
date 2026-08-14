//! `/api/auth/*` — the two ways a human can get a session token.

use serde_json::json;

use super::{ApiError, Client, Method};
use crate::models::Me;

/// Ask the server to email a 6-digit code. 204 on success.
pub fn magic_send(client: &Client, email: &str) -> Result<(), ApiError> {
    client.post("/api/auth/magic/send", &json!({ "email": email }))?;
    Ok(())
}

/// Exchange the emailed code for a sealed session. The token comes back in the
/// response body, which is what makes this usable without a browser.
pub fn magic_verify(client: &Client, email: &str, code: &str) -> Result<Me, ApiError> {
    client.post_as(
        "/api/auth/magic/verify",
        &json!({ "email": email, "code": code }),
    )
}

/// Whether the dev-auth bypass is available.
///
/// The endpoint 404s rather than 403s when disabled — deliberately, so dev auth
/// leaves no detectable surface in production — so "not found" is the answer
/// "no", not an error.
pub fn dev_enabled(client: &Client) -> Result<bool, ApiError> {
    match client.get("/api/auth/dev/enabled", &[]) {
        Ok(_) => Ok(true),
        Err(ApiError::NotFound(_)) => Ok(false),
        Err(e) => Err(e),
    }
}

pub fn dev_login(client: &Client, email: &str, display_name: Option<&str>) -> Result<Me, ApiError> {
    let mut body = json!({ "email": email });
    if let Some(name) = display_name {
        body["display_name"] = json!(name);
    }
    client.post_as("/api/auth/dev/login", &body)
}

/// Server-side logout.
///
/// Worth knowing what this does *not* do: the handler only clears cookies, so
/// for a bearer client it revokes nothing. The token stays valid until it
/// expires on its own. `clawbits logout` says so rather than implying
/// otherwise.
pub fn logout(client: &Client) -> Result<(), ApiError> {
    client.request(Method::Post, "/api/auth/logout", &[], None)?;
    Ok(())
}
