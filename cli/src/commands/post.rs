//! `post` — send a message to a channel.

use anyhow::{bail, Result};
use serde_json::Value;

use super::{message_text, Ctx};
use crate::api::mm::{self, MAX_MESSAGE_CHARS};
use crate::cli::PostArgs;
use crate::models::Post;
use crate::resolve;

pub fn run(ctx: &Ctx, args: &PostArgs) -> Result<()> {
    let channel = resolve::channel(&ctx.client, &ctx.settings, &args.channel)?;
    let body = message_text(&args.message)?;
    validate(&body)?;

    let value = create(ctx, &channel.channel_id, &body, args.reply_to)?;
    report(ctx, &channel.label(), value)
}

/// Check the length here rather than letting the server do it: its answer is a
/// Pydantic 422 whose `detail` is a list of `{loc, msg, type}`, which is a poor
/// way to be told your message is a bit long.
pub fn validate(body: &str) -> Result<()> {
    if body.trim().is_empty() {
        bail!("refusing to send an empty message");
    }
    let chars = body.chars().count();
    if chars > MAX_MESSAGE_CHARS {
        bail!(
            "message is {chars} characters; the limit is {MAX_MESSAGE_CHARS} \
             ({} too many)",
            chars - MAX_MESSAGE_CHARS
        );
    }
    Ok(())
}

pub fn create(ctx: &Ctx, channel_id: &str, body: &str, reply_to: Option<i64>) -> Result<Value> {
    let path = mm::channel_path(channel_id, "/posts");
    let mut payload = serde_json::json!({ "message": body, "status": "published" });
    if let Some(parent) = reply_to {
        payload["parent_post_id"] = serde_json::json!(parent);
    }
    Ok(ctx.client.post(&path, &payload)?)
}

pub fn report(ctx: &Ctx, channel_label: &str, value: Value) -> Result<()> {
    if ctx.settings.json {
        crate::render::print_json(&value);
        return Ok(());
    }
    let post: Post = serde_json::from_value(value)?;
    println!(
        "Posted to {} {}",
        ctx.style.bold(channel_label),
        ctx.style.dim(&format!("[{}]", post.post_id))
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_empty_message() {
        assert!(validate("").is_err());
        assert!(validate("   \n ").is_err());
    }

    #[test]
    fn accepts_a_message_at_the_limit_and_rejects_one_past_it() {
        assert!(validate(&"x".repeat(MAX_MESSAGE_CHARS)).is_ok());
        let err = validate(&"x".repeat(MAX_MESSAGE_CHARS + 7))
            .unwrap_err()
            .to_string();
        assert!(err.contains("7 too many"), "{err}");
    }

    #[test]
    fn counts_characters_not_bytes() {
        // 4000 multi-byte characters is a legal message; counting bytes would
        // reject it for no reason.
        assert!(validate(&"é".repeat(MAX_MESSAGE_CHARS)).is_ok());
    }
}
