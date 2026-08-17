//! Server timestamps.
//!
//! # The API uses two encodings and neither is labelled
//!
//! Messaging rows go through `format_db_timestamp` in
//! `clawbits/utils/parse.py`, which is `strftime("%Y-%m-%d %H:%M:%S")`:
//! space-separated, no sub-seconds, and **no offset** — even though the
//! underlying column is `TIMESTAMPTZ`. The account endpoints call
//! `datetime.isoformat()` instead and emit `2026-08-14T09:12:33+00:00`.
//!
//! So: try RFC 3339 first, then the naive forms interpreted as UTC. The naive
//! reading is what the server means (the database hands out UTC and the
//! offset is dropped on the way out), and it is the half the existing mobile
//! client gets wrong — `apps/mobile/src/lib/formatting.ts` feeds the naive form
//! to `new Date()`, which reads it as *local* time.
//!
//! A value that parses as neither is rendered verbatim rather than raised: a
//! date-formatting problem must never stop you reading your messages.

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};

pub fn parse_server_ts(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, fmt) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    None
}

pub fn to_local(raw: &str) -> Option<DateTime<Local>> {
    parse_server_ts(raw).map(|dt| dt.with_timezone(&Local))
}

/// `09:12`, or the raw string when it can't be parsed.
pub fn clock(raw: &str) -> String {
    match to_local(raw) {
        Some(dt) => dt.format("%H:%M").to_string(),
        None => raw.to_string(),
    }
}

/// `Tue 12 Aug 2026` — the transcript's date separator.
pub fn date_header(raw: &str) -> String {
    match to_local(raw) {
        Some(dt) => dt.format("%a %-d %b %Y").to_string(),
        None => raw.to_string(),
    }
}

/// `12 Aug 09:12` — for list views, where each row needs its own date.
pub fn clock_and_date(raw: &str) -> String {
    match to_local(raw) {
        Some(dt) => dt.format("%-d %b %H:%M").to_string(),
        None => raw.to_string(),
    }
}

/// The local calendar day, used to decide when to emit a date separator.
pub fn local_day(raw: &str) -> Option<String> {
    to_local(raw).map(|dt| dt.format("%Y-%m-%d").to_string())
}

/// Sidebar-style age: `now`, `14m`, `3h`, `2d`, then an absolute date.
pub fn relative(raw: &str, now: DateTime<Utc>) -> String {
    let Some(then) = parse_server_ts(raw) else {
        return raw.to_string();
    };
    let secs = (now - then).num_seconds();
    if secs < 0 {
        // Clock skew between client and server; don't render "-3m".
        return "now".to_string();
    }
    match secs {
        s if s < 60 => "now".to_string(),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s if s < 7 * 86_400 => format!("{}d", s / 86_400),
        _ => then.with_timezone(&Local).format("%-d %b").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_messaging_format() {
        // What every post, channel and search hit actually carries.
        let dt = parse_server_ts("2026-08-14 09:12:33").unwrap();
        assert_eq!(dt.to_rfc3339(), "2026-08-14T09:12:33+00:00");
    }

    #[test]
    fn parses_the_account_format() {
        let dt = parse_server_ts("2026-08-14T09:12:33+00:00").unwrap();
        assert_eq!(dt.to_rfc3339(), "2026-08-14T09:12:33+00:00");
    }

    #[test]
    fn a_real_offset_is_respected_not_ignored() {
        let dt = parse_server_ts("2026-08-14T09:12:33+02:00").unwrap();
        assert_eq!(dt.to_rfc3339(), "2026-08-14T07:12:33+00:00");
    }

    #[test]
    fn handles_sub_seconds_and_the_t_separated_naive_form() {
        assert!(parse_server_ts("2026-08-14 09:12:33.123456").is_some());
        assert!(parse_server_ts("2026-08-14T09:12:33").is_some());
        assert!(parse_server_ts("2026-08-14T09:12:33.5").is_some());
    }

    #[test]
    fn the_naive_form_is_read_as_utc_not_local() {
        // The bug this exists to avoid: reading it as local time shifts every
        // message by the viewer's offset.
        let naive = parse_server_ts("2026-08-14 09:12:33").unwrap();
        let explicit = parse_server_ts("2026-08-14T09:12:33Z").unwrap();
        assert_eq!(naive, explicit);
    }

    #[test]
    fn garbage_is_none_and_renders_verbatim() {
        assert!(parse_server_ts("").is_none());
        assert!(parse_server_ts("not a date").is_none());
        assert!(parse_server_ts("2026-13-45 99:99:99").is_none());
        assert_eq!(clock("not a date"), "not a date");
        assert_eq!(date_header("not a date"), "not a date");
        assert_eq!(relative("not a date", Utc::now()), "not a date");
    }

    #[test]
    fn relative_buckets() {
        let now = parse_server_ts("2026-08-14T12:00:00Z").unwrap();
        assert_eq!(relative("2026-08-14T11:59:30Z", now), "now");
        assert_eq!(relative("2026-08-14T11:46:00Z", now), "14m");
        assert_eq!(relative("2026-08-14T09:00:00Z", now), "3h");
        assert_eq!(relative("2026-08-12T12:00:00Z", now), "2d");
        // Beyond a week it becomes an absolute date; the exact rendering is
        // local-timezone dependent, so only assert it stopped being an age.
        let old = relative("2026-01-02T12:00:00Z", now);
        assert!(!old.ends_with('d') && old != "now", "got {old}");
    }

    #[test]
    fn future_timestamps_do_not_render_negative() {
        let now = parse_server_ts("2026-08-14T12:00:00Z").unwrap();
        assert_eq!(relative("2026-08-14T12:05:00Z", now), "now");
    }

    #[test]
    fn local_day_changes_across_a_day_boundary() {
        let a = local_day("2026-08-14 09:12:33").unwrap();
        let b = local_day("2026-08-14 21:12:33").unwrap();
        let c = local_day("2026-08-16 09:12:33").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
