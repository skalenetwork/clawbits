//! `search` — full-text over messages the caller can see.

use anyhow::Result;

use super::{typed, Ctx};
use crate::api::mm::{self, SearchParams};
use crate::cli::SearchArgs;
use crate::models::SearchResponse;
use crate::render::list::{table, truncate};
use crate::render::{hint, time};
use crate::resolve;

pub fn run(ctx: &Ctx, args: &SearchArgs) -> Result<()> {
    let query = args.query.join(" ");

    // The server resolves `from:` to ids client-side, so do the lookup here.
    // An `@` means a person; anything else is an agent id.
    let mut from_human_id = None;
    let mut from_agent_id = None;
    if let Some(from) = &args.from {
        if from.contains('@') {
            let org = resolve::require_org(&ctx.settings)?;
            from_human_id = Some(resolve::human_id(&ctx.client, &org, from)?);
        } else {
            from_agent_id = Some(from.as_str());
        }
    }

    let channel_id = match &args.channel {
        Some(needle) => Some(resolve::channel(&ctx.client, &ctx.settings, needle)?.channel_id),
        None => None,
    };

    let params = SearchParams {
        q: &query,
        org_id: ctx.settings.org.as_deref(),
        channel_id: channel_id.as_deref(),
        sort: args.sort.as_str(),
        limit: args.limit,
        cursor: args.cursor.as_deref(),
        from_human_id,
        from_agent_id,
        before: args.before.as_deref(),
        after: args.after.as_deref(),
        has_link: args.has_link,
        has_file: args.has_file,
    };

    let value = ctx
        .client
        .get("/api/human/mm/search", &mm::search_query(&params))?;
    let Some(response) = typed::<SearchResponse>(ctx, "/api/human/mm/search", value)? else {
        return Ok(());
    };

    if response.results.is_empty() {
        println!("{}", ctx.style.dim("(no matches)"));
        return Ok(());
    }

    let rows: Vec<Vec<String>> = response
        .results
        .iter()
        .map(|r| {
            let channel = r
                .channel_display_name
                .clone()
                .unwrap_or_else(|| r.channel_id.clone());
            let author = r
                .author
                .as_ref()
                .map(|a| a.label())
                .unwrap_or_else(|| "unknown".into());
            vec![
                ctx.style.dim(&format!("[{}]", r.post_id)),
                truncate(&channel, 20),
                truncate(&author, 16),
                ctx.style.dim(&time::clock_and_date(&r.created_at)),
                highlight(ctx, &r.snippet),
            ]
        })
        .collect();

    print!(
        "{}",
        table(
            &["ID", "CHANNEL", "FROM", "WHEN", "MATCH"],
            &rows,
            &ctx.style
        )
    );

    // To stderr: a cursor in the middle of piped output would corrupt it.
    if let Some(cursor) = &response.next_cursor {
        hint(&format!("more results — continue with: --cursor {cursor}"));
    }
    Ok(())
}

/// Postgres `ts_headline` wraps matched terms in `<mark>…</mark>` and
/// HTML-escapes the rest. Turn that into colour, or strip it when there's no
/// colour to turn it into.
fn highlight(ctx: &Ctx, snippet: &str) -> String {
    let flat = unescape_html(snippet).replace(['\n', '\r'], " ");
    let mut out = String::with_capacity(flat.len());
    let mut rest = flat.as_str();
    while let Some(start) = rest.find("<mark>") {
        out.push_str(&rest[..start]);
        rest = &rest[start + "<mark>".len()..];
        match rest.find("</mark>") {
            Some(end) => {
                out.push_str(&ctx.style.hit(&rest[..end]));
                rest = &rest[end + "</mark>".len()..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    truncate(&out, 80)
}

fn unescape_html(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        // Ampersand last, or "&amp;lt;" would become "<".
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::style::Style;

    fn ctx_plain() -> Ctx {
        // Only `style` and `settings.json` are touched by `highlight`.
        use crate::api::Client;
        use crate::cli::ColorMode;
        use crate::config::{Config, Paths};
        use crate::settings::Settings;
        use std::time::Duration;

        Ctx {
            client: Client::new("http://localhost:8000", None, Duration::from_secs(1), false),
            settings: Settings {
                base_url: "http://localhost:8000".into(),
                profile: "default".into(),
                org: None,
                json: false,
                color: ColorMode::Never,
                timeout: Duration::from_secs(1),
                verbose: false,
            },
            paths: Paths::under(std::path::Path::new("/tmp/clawbits-test")),
            config: Config::default(),
            style: Style::plain(),
        }
    }

    #[test]
    fn strips_mark_tags_when_not_colouring() {
        let ctx = ctx_plain();
        assert_eq!(
            highlight(&ctx, "the <mark>deploy</mark> is green"),
            "the deploy is green"
        );
    }

    #[test]
    fn unescapes_what_ts_headline_escaped() {
        let ctx = ctx_plain();
        assert_eq!(
            highlight(&ctx, "a &lt;tag&gt; &amp; more"),
            "a <tag> & more"
        );
        // Ampersand is decoded last so a double-encoded sequence survives.
        assert_eq!(highlight(&ctx, "&amp;lt;"), "&lt;");
    }

    #[test]
    fn an_unclosed_mark_tag_does_not_lose_the_rest() {
        let ctx = ctx_plain();
        let out = highlight(&ctx, "start <mark>middle end");
        assert!(out.contains("start"), "{out}");
        assert!(out.contains("middle end"), "{out}");
    }

    #[test]
    fn newlines_are_flattened_so_a_row_stays_one_row() {
        let ctx = ctx_plain();
        assert!(!highlight(&ctx, "a\nb").contains('\n'));
    }
}
