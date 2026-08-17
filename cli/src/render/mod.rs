//! Terminal output.
//!
//! Two rules the commands rely on:
//!
//! * **stdout is the payload.** Transcripts, tables and JSON go there and
//!   nothing else does, so `cbs read general > log.txt` is exactly the
//!   transcript.
//! * **stderr is the commentary.** Pagination cursors, "3 more above", warnings
//!   — anything a pipe shouldn't swallow — goes through [`hint`].

pub mod list;
pub mod style;
pub mod time;
pub mod transcript;

use std::io::IsTerminal;

use serde_json::Value;

/// Machine output. Pretty-printed at a terminal (a human is reading it),
/// compact when piped (a program is).
pub fn print_json(value: &Value) {
    if std::io::stdout().is_terminal() {
        println!(
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_default()
        );
    } else {
        println!("{}", serde_json::to_string(value).unwrap_or_default());
    }
}

/// Commentary, never part of the piped payload.
pub fn hint(message: &str) {
    eprintln!("{message}");
}
