//! Colour and glyph decisions.
//!
//! Two independent questions, because they have different answers:
//!
//! * **Colour** follows `--color`, `NO_COLOR` and whether stdout is a tty.
//! * **Glyphs** (📌, 📎, box-drawing rules) follow the tty alone. Someone who
//!   passes `--color never` at an interactive terminal still has a terminal;
//!   someone redirecting to a file wants plain ASCII in the file.

use std::io::IsTerminal;

use crate::cli::ColorMode;

#[derive(Debug, Clone, Copy)]
pub struct Style {
    pub color: bool,
    pub glyphs: bool,
}

const RESET: &str = "\x1b[0m";
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const CYAN: &str = "\x1b[36m";
const YELLOW: &str = "\x1b[33m";
const GREEN: &str = "\x1b[32m";

impl Style {
    pub fn decide(mode: ColorMode) -> Self {
        let tty = std::io::stdout().is_terminal();
        Self {
            color: color_enabled(mode, tty, std::env::var_os("NO_COLOR").is_some(), forced()),
            glyphs: tty,
        }
    }

    /// Everything off. Used for `--json` and in tests.
    pub fn plain() -> Self {
        Self {
            color: false,
            glyphs: false,
        }
    }

    fn wrap(&self, code: &str, s: &str) -> String {
        if self.color {
            format!("{code}{s}{RESET}")
        } else {
            s.to_string()
        }
    }

    pub fn dim(&self, s: &str) -> String {
        self.wrap(DIM, s)
    }
    pub fn bold(&self, s: &str) -> String {
        self.wrap(BOLD, s)
    }
    pub fn author(&self, s: &str) -> String {
        self.wrap(CYAN, s)
    }
    /// Unread counts and mention badges.
    pub fn accent(&self, s: &str) -> String {
        self.wrap(YELLOW, s)
    }
    pub fn hit(&self, s: &str) -> String {
        self.wrap(GREEN, s)
    }

    /// A glyph when the terminal will render it, an ASCII tag otherwise.
    pub fn glyph(&self, glyph: &str, fallback: &str) -> String {
        if self.glyphs {
            glyph.to_string()
        } else {
            fallback.to_string()
        }
    }

    pub fn rule(&self, width: usize) -> String {
        let ch = if self.glyphs { '─' } else { '-' };
        std::iter::repeat_n(ch, width).collect()
    }
}

fn forced() -> bool {
    std::env::var("CLICOLOR_FORCE").as_deref() == Ok("1")
}

/// Pulled out so the precedence is testable without touching the environment.
///
/// `NO_COLOR` is honoured for any value, per the no-color.org convention, and
/// beats `auto` but not an explicit `--color always`.
fn color_enabled(mode: ColorMode, tty: bool, no_color: bool, force: bool) -> bool {
    match mode {
        ColorMode::Always => true,
        ColorMode::Never => false,
        ColorMode::Auto => {
            if no_color {
                false
            } else if force {
                true
            } else {
                tty
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_follows_the_terminal() {
        assert!(color_enabled(ColorMode::Auto, true, false, false));
        assert!(!color_enabled(ColorMode::Auto, false, false, false));
    }

    #[test]
    fn no_color_beats_auto_but_not_an_explicit_request() {
        assert!(!color_enabled(ColorMode::Auto, true, true, false));
        assert!(color_enabled(ColorMode::Always, true, true, false));
    }

    #[test]
    fn clicolor_force_turns_it_on_off_tty() {
        assert!(color_enabled(ColorMode::Auto, false, false, true));
        // NO_COLOR still wins — declining is the safer default when both are set.
        assert!(!color_enabled(ColorMode::Auto, false, true, true));
    }

    #[test]
    fn never_is_never() {
        assert!(!color_enabled(ColorMode::Never, true, false, true));
    }

    #[test]
    fn plain_style_emits_no_escapes() {
        let s = Style::plain();
        assert_eq!(s.bold("hi"), "hi");
        assert_eq!(s.dim("hi"), "hi");
        assert_eq!(s.accent("3"), "3");
        assert_eq!(s.glyph("📌", "[pinned]"), "[pinned]");
        assert_eq!(s.rule(3), "---");
    }

    #[test]
    fn colored_style_wraps_and_resets() {
        let s = Style {
            color: true,
            glyphs: true,
        };
        let out = s.bold("hi");
        assert!(out.starts_with(BOLD) && out.ends_with(RESET));
        assert_eq!(s.glyph("📌", "[pinned]"), "📌");
        assert_eq!(s.rule(3), "───");
    }
}
