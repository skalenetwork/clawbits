//! Column-aligned tables for the list-shaped commands.

use super::style::Style;

/// Render a header row plus body rows, padded to the widest cell per column.
///
/// The last column is never padded, so a long trailing preview doesn't drag a
/// wall of spaces along with it.
pub fn table(headers: &[&str], rows: &[Vec<String>], style: &Style) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let columns = headers.len();
    let mut widths: Vec<usize> = headers.iter().map(|h| visible_width(h)).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate().take(columns) {
            widths[i] = widths[i].max(visible_width(cell));
        }
    }

    let mut out = String::new();
    out.push_str(&style.dim(&join_padded(
        &headers.iter().map(|h| h.to_string()).collect::<Vec<_>>(),
        &widths,
    )));
    out.push('\n');
    for row in rows {
        out.push_str(&join_padded(row, &widths));
        out.push('\n');
    }
    out
}

fn join_padded(cells: &[String], widths: &[usize]) -> String {
    let last = cells.len().saturating_sub(1);
    let mut line = String::new();
    for (i, cell) in cells.iter().enumerate() {
        if i == last {
            line.push_str(cell);
        } else {
            line.push_str(&pad(cell, widths[i]));
            line.push_str("  ");
        }
    }
    line.trim_end().to_string()
}

pub fn pad(s: &str, width: usize) -> String {
    let w = visible_width(s);
    if w >= width {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(width - w))
    }
}

/// Character count ignoring ANSI escape sequences.
///
/// Cells are coloured before they get here, so counting raw chars would pad by
/// the length of the escape codes and wreck the alignment. Not grapheme- or
/// East-Asian-width aware — that would mean another dependency for a case this
/// tool rarely hits.
pub fn visible_width(s: &str) -> usize {
    let mut width = 0;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Consume through the terminating letter of the CSI sequence.
            for esc in chars.by_ref() {
                if esc.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            width += 1;
        }
    }
    width
}

/// Shorten to `max` characters with an ellipsis, for previews.
pub fn truncate(s: &str, max: usize) -> String {
    let flat = s.replace(['\n', '\r'], " ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

pub fn human_size(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_codes_do_not_count_toward_width() {
        assert_eq!(visible_width("abc"), 3);
        assert_eq!(visible_width("\x1b[1mabc\x1b[0m"), 3);
        assert_eq!(visible_width("\x1b[36mhi\x1b[0m there"), 8);
        assert_eq!(visible_width(""), 0);
    }

    #[test]
    fn padding_uses_visible_width_so_colour_does_not_skew_columns() {
        let plain = pad("ab", 5);
        let colored = pad("\x1b[1mab\x1b[0m", 5);
        assert_eq!(visible_width(&plain), 5);
        assert_eq!(visible_width(&colored), 5);
    }

    #[test]
    fn padding_never_truncates() {
        assert_eq!(pad("abcdef", 3), "abcdef");
    }

    #[test]
    fn table_aligns_on_the_widest_cell() {
        let rows = vec![
            vec!["#general".into(), "3".into()],
            vec!["#engineering-standup".into(), "0".into()],
        ];
        let out = table(&["NAME", "UNREAD"], &rows, &Style::plain());
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3);
        // Both body rows put UNREAD at the same column.
        let col = |l: &str| l.find(|c: char| c.is_ascii_digit()).unwrap();
        assert_eq!(col(lines[1]), col(lines[2]));
    }

    #[test]
    fn empty_rows_render_nothing_not_a_lonely_header() {
        assert_eq!(table(&["NAME"], &[], &Style::plain()), "");
    }

    #[test]
    fn truncate_flattens_newlines_and_marks_the_cut() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("a\nb", 10), "a b");
        let out = truncate("abcdefghij", 5);
        assert_eq!(out.chars().count(), 5);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn sizes_are_human_readable() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024), "1.0 KB");
        assert_eq!(human_size(1_258_291), "1.2 MB");
        assert_eq!(human_size(5_368_709_120), "5.0 GB");
    }
}
