//! The command-line surface.
//!
//! Every clap type lives here and *only* clap types live here — no I/O, no
//! logic. That keeps the whole surface testable with `try_parse_from` and
//! makes `Cli::command().debug_assert()` a meaningful check.
//!
//! # Why there is no `--token`
//!
//! argv is world-readable: `ps` and `/proc/<pid>/cmdline` expose it to every
//! other user on the box. The Hermes client documents this the hard way (see
//! `extensions/hermes/cli_client.py`), which is why it passes the agent key
//! through the environment instead. The session token here comes from
//! `$CLAWBITS_TOKEN` or the 0600 session file, never from a flag. There is a
//! test in this module that fails if someone adds one.

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Parser, Debug)]
#[command(
    name = "clawbits",
    version,
    about = "Read and post to Clawbits from a terminal",
    long_about = "Terminal client for the Clawbits human messaging API.\n\n\
                  Start with `clawbits login`, then `clawbits channels`.",
    after_help = "Exit codes: 0 ok · 1 error · 2 usage · 3 not signed in · \
                  4 forbidden · 5 not found · 6 network"
)]
pub struct Cli {
    /// Clawbits server to talk to.
    #[arg(long, global = true, env = "CLAWBITS_BASE_URL", value_name = "URL")]
    pub base_url: Option<String>,

    /// Named credential/config set, for using more than one server or identity.
    #[arg(long, global = true, env = "CLAWBITS_PROFILE", value_name = "NAME")]
    pub profile: Option<String>,

    /// Organization to scope to (id or name). Defaults to `clawbits orgs use`.
    #[arg(long, global = true, env = "CLAWBITS_ORG", value_name = "ORG")]
    pub org: Option<String>,

    /// Emit the server's JSON verbatim instead of formatted text.
    #[arg(long, global = true)]
    pub json: bool,

    /// When to colorize output.
    #[arg(long, global = true, value_enum, default_value_t = ColorMode::Auto,
          env = "CLAWBITS_COLOR", value_name = "WHEN")]
    pub color: ColorMode,

    /// Per-request timeout in seconds.
    #[arg(long, global = true, default_value_t = 30, value_name = "SECS")]
    pub timeout: u64,

    /// Log each request's method, path and status to stderr (never bodies).
    #[arg(short, long, global = true)]
    pub verbose: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorMode {
    Auto,
    Always,
    Never,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Sign in and store a session token.
    Login(LoginArgs),
    /// Forget the stored session token.
    Logout(LogoutArgs),
    /// Show who the stored session belongs to.
    Whoami,
    /// List organizations, or pick the default one.
    Orgs(OrgsArgs),
    /// List channels you belong to.
    Channels(ChannelsArgs),
    /// Print a channel's messages.
    Read(ReadArgs),
    /// Post a message to a channel.
    Post(PostArgs),
    /// Direct messages.
    Dm(DmArgs),
    /// List the members of a channel.
    Members(MembersArgs),
    /// Full-text search over messages you can see.
    Search(SearchArgs),
    /// Personal access tokens — long-lived credentials for scripts and CI.
    Tokens(TokensArgs),
    /// Call an arbitrary API path with auth attached.
    Raw(RawArgs),
    /// Inspect CLI configuration.
    Config(ConfigArgs),
    /// Print a shell completion script.
    Completions {
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
}

#[derive(Args, Debug)]
pub struct LoginArgs {
    /// Email to sign in as. Prompted for when omitted.
    #[arg(long, value_name = "EMAIL")]
    pub email: Option<String>,

    /// Use the local dev-auth bypass instead of emailing a code.
    #[arg(long)]
    pub dev: bool,

    /// Display name, dev login only, used when creating the account.
    #[arg(long, value_name = "NAME", requires = "dev")]
    pub display_name: Option<String>,

    /// The 6-digit emailed code. Prompted for when omitted.
    ///
    /// Safe on argv in a way the session token is not: it is single-use and
    /// expires in minutes, so a leak through `ps` is not a durable credential.
    #[arg(long, value_name = "CODE", conflicts_with = "dev")]
    pub code: Option<String>,

    /// Sign in with a personal access token, read from stdin.
    ///
    /// Mint one with `clawbits tokens create`. Stdin-only on purpose — a
    /// token flag would put the credential on argv, which `ps` exposes.
    #[arg(long, conflicts_with_all = ["dev", "code"])]
    pub pat: bool,

    /// Also persist --base-url as this profile's server.
    #[arg(long)]
    pub save_base_url: bool,
}

#[derive(Args, Debug)]
pub struct LogoutArgs {
    /// Forget every profile's session, not just this one.
    #[arg(long)]
    pub all: bool,
}

#[derive(Args, Debug)]
pub struct OrgsArgs {
    #[command(subcommand)]
    pub cmd: Option<OrgsCommand>,
}

#[derive(Subcommand, Debug)]
pub enum OrgsCommand {
    /// Set the default organization for this profile.
    Use {
        /// Organization id or name.
        org: String,
    },
}

#[derive(Args, Debug)]
pub struct ChannelsArgs {
    /// Every org you belong to, not just the current one.
    #[arg(long)]
    pub all_orgs: bool,

    /// Only channels with unread messages.
    #[arg(long)]
    pub unread: bool,

    /// Only direct messages.
    #[arg(long)]
    pub dms: bool,

    /// Show at most this many.
    #[arg(long, value_name = "N")]
    pub limit: Option<usize>,
}

#[derive(Args, Debug)]
pub struct ReadArgs {
    /// Channel id, name, or #name.
    pub channel: String,

    /// How many messages to fetch.
    #[arg(short = 'n', long, default_value_t = 50, value_name = "N")]
    pub limit: u32,

    /// Only messages older than this post id.
    #[arg(long, value_name = "POST_ID")]
    pub before: Option<i64>,

    /// Only messages newer than this post id.
    #[arg(long, value_name = "POST_ID", conflicts_with = "before")]
    pub after: Option<i64>,

    /// Show only a post and its replies.
    #[arg(long, value_name = "POST_ID")]
    pub thread: Option<i64>,

    /// Also mark the channel read up to the newest message shown.
    ///
    /// Off by default so `clawbits read foo | grep bar` doesn't silently
    /// clear your unread badge as a side effect of grepping.
    #[arg(long)]
    pub mark_read: bool,
}

#[derive(Args, Debug)]
pub struct PostArgs {
    /// Channel id, name, or #name.
    pub channel: String,

    #[command(flatten)]
    pub message: MessageInput,

    /// Reply in-thread to this post id.
    #[arg(long, value_name = "POST_ID")]
    pub reply_to: Option<i64>,
}

/// Where a message body comes from. Shared by `post` and `dm send`.
///
/// With neither flag: read stdin when it's a pipe, otherwise open $EDITOR.
#[derive(Args, Debug)]
pub struct MessageInput {
    /// The message text.
    #[arg(short = 'm', long, value_name = "TEXT", conflicts_with = "stdin")]
    pub message: Option<String>,

    /// Read the message from stdin.
    #[arg(long)]
    pub stdin: bool,
}

#[derive(Args, Debug)]
pub struct DmArgs {
    #[command(subcommand)]
    pub cmd: DmCommand,
}

#[derive(Subcommand, Debug)]
pub enum DmCommand {
    /// List your direct-message channels.
    List,
    /// Open (or find) a DM and print its channel id.
    Open(DmTarget),
    /// Open a DM if needed, then post to it.
    Send(DmSendArgs),
}

#[derive(Args, Debug)]
pub struct DmTarget {
    /// A person, by numeric user id or email.
    #[arg(long, value_name = "ID|EMAIL", conflicts_with = "agent")]
    pub user: Option<String>,

    /// An agent, by agent id.
    #[arg(long, value_name = "AGENT_ID")]
    pub agent: Option<String>,
}

#[derive(Args, Debug)]
pub struct DmSendArgs {
    #[command(flatten)]
    pub target: DmTarget,

    #[command(flatten)]
    pub message: MessageInput,

    /// Reply in-thread to this post id.
    #[arg(long, value_name = "POST_ID")]
    pub reply_to: Option<i64>,
}

#[derive(Args, Debug)]
pub struct MembersArgs {
    /// Channel id, name, or #name.
    pub channel: String,
}

#[derive(Args, Debug)]
pub struct SearchArgs {
    /// What to search for.
    pub query: Vec<String>,

    /// Restrict to one channel.
    #[arg(long, value_name = "CHANNEL")]
    pub channel: Option<String>,

    /// Only messages from this person (email) or agent (agent id).
    #[arg(long = "from", value_name = "EMAIL|AGENT_ID")]
    pub from: Option<String>,

    /// Only messages before this date (YYYY-MM-DD).
    #[arg(long, value_name = "DATE")]
    pub before: Option<String>,

    /// Only messages after this date (YYYY-MM-DD).
    #[arg(long, value_name = "DATE")]
    pub after: Option<String>,

    /// Only messages containing a link.
    #[arg(long)]
    pub has_link: bool,

    /// Only messages with an attachment.
    #[arg(long)]
    pub has_file: bool,

    /// Result ordering.
    #[arg(long, value_enum, default_value_t = SearchSort::Recent)]
    pub sort: SearchSort,

    /// How many results (server clamps to 50).
    #[arg(long, default_value_t = 25, value_name = "N")]
    pub limit: u32,

    /// Continue from a previous search's cursor.
    #[arg(long, value_name = "CURSOR")]
    pub cursor: Option<String>,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchSort {
    Recent,
    Relevant,
}

impl SearchSort {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchSort::Recent => "recent",
            SearchSort::Relevant => "relevant",
        }
    }
}

#[derive(Args, Debug)]
pub struct TokensArgs {
    #[command(subcommand)]
    pub cmd: TokensCommand,
}

#[derive(Subcommand, Debug)]
pub enum TokensCommand {
    /// Mint a new token. The plaintext is printed once and never stored.
    Create {
        /// What this token is for, e.g. "CI" or "laptop".
        #[arg(long, value_name = "TEXT")]
        label: String,

        /// Days until it stops working (1–365). Omit for no expiry.
        #[arg(long, value_name = "DAYS")]
        expires_days: Option<u32>,
    },
    /// List your tokens — hints and metadata, never the plaintext.
    List,
    /// Revoke a token by id. Takes effect immediately.
    Revoke { token_id: i64 },
}

#[derive(Args, Debug)]
pub struct RawArgs {
    /// `ignore_case` because HTTP methods are conventionally written in caps —
    /// every curl example and the Hermes agent CLI use `GET`/`POST`, and clap
    /// would otherwise accept only the lowercased variant names.
    #[arg(value_enum, ignore_case = true)]
    pub method: HttpMethod,

    /// Path beginning with `/`, e.g. /api/human/orgs.
    pub path: String,

    /// Query parameter as key=value. Repeatable.
    #[arg(long, value_name = "K=V")]
    pub query: Vec<String>,

    /// JSON request body, or @path to read it from a file.
    #[arg(long, value_name = "JSON|@FILE")]
    pub data: Option<String>,

    /// Print the status line and response headers to stderr.
    #[arg(long)]
    pub include: bool,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Args, Debug)]
pub struct ConfigArgs {
    #[command(subcommand)]
    pub cmd: ConfigCommand,
}

#[derive(Subcommand, Debug)]
pub enum ConfigCommand {
    /// Print where the config and session files live.
    Path,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn command_tree_is_internally_consistent() {
        Cli::command().debug_assert();
    }

    /// argv is world-readable through `ps` and /proc/<pid>/cmdline, so a
    /// session token must never be passable as a flag. If you are here
    /// because this test failed: put the secret in the environment, on
    /// stdin (the way `login --pat` does), or in the 0600 session file.
    ///
    /// A trailing `_id` is exempt: `tokens revoke <token_id>` takes the
    /// row id shown in `tokens list` — a public reference to a credential,
    /// not the credential.
    #[test]
    fn no_command_takes_a_secret_on_argv() {
        fn walk(cmd: &clap::Command) {
            for arg in cmd.get_arguments() {
                let id = arg.get_id().as_str();
                if id.ends_with("_id") {
                    continue;
                }
                assert!(
                    !id.contains("token") && !id.contains("api_key") && !id.contains("secret"),
                    "`{}` exposes a secret on argv via --{}",
                    cmd.get_name(),
                    id
                );
            }
            for sub in cmd.get_subcommands() {
                walk(sub);
            }
        }
        walk(&Cli::command());
    }

    #[test]
    fn login_pat_conflicts_with_the_other_login_modes() {
        assert!(Cli::try_parse_from(["clawbits", "login", "--pat", "--dev"]).is_err());
        assert!(Cli::try_parse_from(["clawbits", "login", "--pat", "--code", "123456"]).is_err());
        assert!(Cli::try_parse_from(["clawbits", "login", "--pat"]).is_ok());
    }

    #[test]
    fn tokens_subcommands_parse() {
        assert!(Cli::try_parse_from(["clawbits", "tokens", "list"]).is_ok());
        assert!(Cli::try_parse_from(["clawbits", "tokens", "revoke", "7"]).is_ok());
        assert!(Cli::try_parse_from([
            "clawbits",
            "tokens",
            "create",
            "--label",
            "ci",
            "--expires-days",
            "90"
        ])
        .is_ok());
        // A label is not optional — an unlabelled token is unidentifiable in
        // the list, which is how tokens end up never revoked.
        assert!(Cli::try_parse_from(["clawbits", "tokens", "create"]).is_err());
    }

    #[test]
    fn message_and_stdin_are_mutually_exclusive() {
        assert!(
            Cli::try_parse_from(["clawbits", "post", "general", "-m", "hi", "--stdin"]).is_err()
        );
        assert!(Cli::try_parse_from(["clawbits", "post", "general", "-m", "hi"]).is_ok());
        assert!(Cli::try_parse_from(["clawbits", "post", "general", "--stdin"]).is_ok());
    }

    #[test]
    fn read_cursors_are_mutually_exclusive() {
        assert!(
            Cli::try_parse_from(["clawbits", "read", "g", "--before", "1", "--after", "2"])
                .is_err()
        );
    }

    #[test]
    fn dm_targets_are_mutually_exclusive() {
        assert!(
            Cli::try_parse_from(["clawbits", "dm", "open", "--user", "a@b.c", "--agent", "x"])
                .is_err()
        );
    }

    #[test]
    fn display_name_is_dev_login_only() {
        // Without --dev there is no account-creation step to name.
        assert!(Cli::try_parse_from(["clawbits", "login", "--display-name", "Al"]).is_err());
        assert!(
            Cli::try_parse_from(["clawbits", "login", "--dev", "--display-name", "Al"]).is_ok()
        );
    }

    #[test]
    fn globals_are_accepted_after_the_subcommand() {
        let cli = Cli::try_parse_from(["clawbits", "read", "general", "--json"]).unwrap();
        assert!(cli.json);
    }

    #[test]
    fn raw_accepts_http_methods_in_the_case_people_write_them() {
        for method in ["GET", "get", "Get"] {
            assert!(
                Cli::try_parse_from(["clawbits", "raw", method, "/api/human/orgs"]).is_ok(),
                "raw should accept {method}"
            );
        }
        assert!(Cli::try_parse_from(["clawbits", "raw", "FETCH", "/x"]).is_err());
    }

    #[test]
    fn orgs_works_bare_and_with_use() {
        let bare = Cli::try_parse_from(["clawbits", "orgs"]).unwrap();
        assert!(matches!(
            bare.command,
            Command::Orgs(OrgsArgs { cmd: None })
        ));
        let used = Cli::try_parse_from(["clawbits", "orgs", "use", "acme"]).unwrap();
        assert!(matches!(
            used.command,
            Command::Orgs(OrgsArgs {
                cmd: Some(OrgsCommand::Use { .. })
            })
        ));
    }
}
