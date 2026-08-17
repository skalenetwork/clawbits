//! `raw` — the escape hatch.
//!
//! Mirrors the `raw METHOD PATH` subcommand the Hermes agent CLI carries. This
//! wraps only the human messaging surface, but the API is much larger; rather
//! than pretend otherwise, `raw` attaches auth and the base URL and gets out of
//! the way.

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::Ctx;
use crate::api::Method;
use crate::cli::{HttpMethod, RawArgs};
use crate::render::hint;

pub fn run(ctx: &Ctx, args: &RawArgs) -> Result<()> {
    if !args.path.starts_with('/') {
        bail!("path must start with `/`, e.g. /api/human/orgs");
    }

    let query = parse_query(&args.query)?;
    let query_refs: Vec<(&str, String)> =
        query.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();

    let body = match &args.data {
        Some(raw) => Some(parse_data(raw)?),
        None => None,
    };

    let response =
        ctx.client
            .execute(method(args.method), &args.path, &query_refs, body.as_ref())?;

    if args.include {
        hint(&format!("HTTP {}", response.status));
        for (name, value) in &response.headers {
            // Never echo a rotated session token into a log.
            let shown = if name.eq_ignore_ascii_case("set-cookie") {
                "<redacted>"
            } else {
                value.as_str()
            };
            hint(&format!("{name}: {shown}"));
        }
    }

    print_body(&response.body);

    if !(200..300).contains(&response.status) {
        // The body has already been printed; make the shell agree it failed.
        return Err(crate::api::ApiError::from_status(response.status, &response.body).into());
    }
    Ok(())
}

fn print_body(body: &str) {
    if body.trim().is_empty() {
        return;
    }
    match serde_json::from_str::<Value>(body) {
        Ok(value) => crate::render::print_json(&value),
        // Not JSON — an HTML error page, say. Pass it through untouched.
        Err(_) => println!("{body}"),
    }
}

fn method(m: HttpMethod) -> Method {
    match m {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
        HttpMethod::Put => Method::Put,
        HttpMethod::Patch => Method::Patch,
        HttpMethod::Delete => Method::Delete,
    }
}

/// `k=v`, where the value may itself contain `=`.
pub fn parse_query(pairs: &[String]) -> Result<Vec<(String, String)>> {
    pairs
        .iter()
        .map(|pair| {
            pair.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .with_context(|| format!("--query expects key=value, got {pair:?}"))
        })
        .collect()
}

/// Literal JSON, or `@path` to read it from a file.
///
/// The file form exists so a body containing secrets never has to appear in
/// argv, where `ps` would expose it.
pub fn parse_data(raw: &str) -> Result<Value> {
    let text = match raw.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path)
            .with_context(|| format!("reading request body from {path}"))?,
        None => raw.to_string(),
    };
    serde_json::from_str(&text).context("--data must be valid JSON")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_query_pairs() {
        let out = parse_query(&["limit=10".into(), "org_id=org_1".into()]).unwrap();
        assert_eq!(
            out,
            vec![
                ("limit".to_string(), "10".to_string()),
                ("org_id".to_string(), "org_1".to_string())
            ]
        );
    }

    #[test]
    fn a_value_may_contain_equals_signs() {
        // Search cursors are base64 and routinely end in padding.
        let out = parse_query(&["cursor=eyJhIjoxfQ==".into()]).unwrap();
        assert_eq!(out[0].1, "eyJhIjoxfQ==");
    }

    #[test]
    fn rejects_a_pair_with_no_equals() {
        let err = parse_query(&["nope".into()]).unwrap_err().to_string();
        assert!(err.contains("key=value"), "{err}");
    }

    #[test]
    fn parses_inline_json() {
        let v = parse_data(r#"{"a":1}"#).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn rejects_malformed_json_with_a_clear_message() {
        let err = parse_data("{nope}").unwrap_err().to_string();
        assert!(err.contains("valid JSON"), "{err}");
    }

    #[test]
    fn reads_json_from_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("body.json");
        std::fs::write(&path, r#"{"message":"hi"}"#).unwrap();
        let v = parse_data(&format!("@{}", path.display())).unwrap();
        assert_eq!(v["message"], "hi");
    }

    #[test]
    fn missing_file_names_the_path() {
        let err = parse_data("@/nonexistent/body.json")
            .unwrap_err()
            .to_string();
        assert!(err.contains("/nonexistent/body.json"), "{err}");
    }
}
