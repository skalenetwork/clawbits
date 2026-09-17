use anyhow::{Context, Result, bail};
use clap::Parser;
use serde::{Deserialize, de::DeserializeOwned};
use std::ffi::OsStr;
use std::fs;
use std::io::{IsTerminal, Write, stdin, stdout};
use std::path::{Path, PathBuf};
use std::process::Command;

const IMAGES: &str = env!("CARGO_MANIFEST_DIR");
const STAGED: &str = ".plugin";
const ARCHIVE: &str = ".plugin.tar";
const METADATA: &str = ".metadata.json";
const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, \
     application/vnd.docker.distribution.manifest.list.v2+json, \
     application/vnd.oci.image.manifest.v1+json, \
     application/vnd.docker.distribution.manifest.v2+json";

struct Recipe {
    name: &'static str,
    repo: &'static str,
    prefix: &'static str,
    engine: Engine,
    plugin: Plugin,
}

enum Engine {
    Npm {
        package: &'static str,
        image: &'static str,
        suffix: &'static str,
    },
    Release {
        github: &'static str,
        image: &'static str,
    },
}

enum Plugin {
    ClawHub(&'static str),
    Tree(&'static str),
}

const RECIPES: &[Recipe] = &[
    Recipe {
        name: "openclaw",
        repo: "ghcr.io/skalenetwork/clawbits-openclaw",
        prefix: "oc",
        engine: Engine::Npm {
            package: "openclaw",
            image: "ghcr.io/openclaw/openclaw",
            suffix: "-browser",
        },
        plugin: Plugin::ClawHub("clawbits-openclaw-plugin"),
    },
    Recipe {
        name: "hermes",
        repo: "ghcr.io/skalenetwork/clawbits-hermes",
        prefix: "hm",
        engine: Engine::Release {
            github: "NousResearch/hermes-agent",
            image: "docker.io/nousresearch/hermes-agent",
        },
        plugin: Plugin::Tree("extensions/hermes"),
    },
];

struct Plan {
    dir: PathBuf,
    repo: &'static str,
    image: String,
    version: String,
    base: String,
    engine: String,
    plugin: String,
    stage: Option<&'static str>,
}

/// Build a clawbits agent image.
#[derive(Parser)]
#[command(name = "clawbits-image", version)]
struct Cli {
    /// Image to build; defaults to the first in the catalog
    image: Option<String>,
    /// Engine version to bake instead of the latest published
    #[arg(long, value_name = "VERSION")]
    engine: Option<String>,
    /// Plugin version to bake instead of the latest published
    #[arg(long, value_name = "VERSION")]
    plugin: Option<String>,
    /// Bake the working-tree plugin; never pushed
    #[arg(long, conflicts_with_all = ["plugin", "push", "digest"])]
    local: bool,
    /// Push to the registry instead of loading into docker
    #[arg(long)]
    push: bool,
    /// Push by digest with no tag, for the multi-arch merge
    #[arg(long, requires = "push")]
    digest: bool,
    /// Skip the confirmation prompt
    #[arg(long, short)]
    yes: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let recipe = pick(cli.image.as_deref())?;
    let plan = resolve(recipe, &cli)?;

    println!("  engine   {:<12} {}", plan.engine, plan.base);
    println!("  plugin   {}", plan.plugin);
    println!("  image    {}\n", plan.image);
    if !cli.yes && stdin().is_terminal() && !matches!(ask("build? [Y/n]")?.as_str(), "" | "y" | "Y")
    {
        return Ok(());
    }

    recipe.plugin.prepare(&plan.dir, cli.local)?;
    let built = build(&plan, cli.push, cli.digest);
    fs::remove_dir_all(plan.dir.join(STAGED)).ok();
    built
}

fn pick(name: Option<&str>) -> Result<&'static Recipe> {
    let Some(name) = name else {
        return Ok(&RECIPES[0]);
    };
    RECIPES.iter().find(|r| r.name == name).with_context(|| {
        let names: Vec<_> = RECIPES.iter().map(|r| r.name).collect();
        format!("unknown image `{name}` (have: {})", names.join(", "))
    })
}

fn resolve(recipe: &'static Recipe, cli: &Cli) -> Result<Plan> {
    let engine = match &cli.engine {
        Some(version) => version.clone(),
        None => recipe.engine.latest()?,
    };
    let tag = recipe.engine.tag(&engine);
    let base = format!("{}:{tag}", recipe.engine.image());
    if !published(recipe.engine.image(), &tag)? {
        bail!("{base} is not published; pass --engine <version>");
    }

    let plugin = recipe.plugin.version(cli)?;
    let prefix = recipe.prefix;
    let version = match cli.local {
        true => format!("{prefix}{engine}-local"),
        false => format!("{prefix}{engine}-pl{plugin}-g{}", head()?),
    };
    Ok(Plan {
        dir: Path::new(IMAGES).join(recipe.name),
        repo: recipe.repo,
        image: format!("{}:{version}", recipe.repo),
        version,
        base,
        engine,
        plugin,
        stage: recipe.plugin.stage(cli.local),
    })
}

impl Engine {
    fn image(&self) -> &'static str {
        match self {
            Self::Npm { image, .. } | Self::Release { image, .. } => image,
        }
    }

    fn latest(&self) -> Result<String> {
        match self {
            Self::Npm { package, .. } => npm_latest(package),
            Self::Release { github, .. } => github_latest(github),
        }
    }

    fn tag(&self, version: &str) -> String {
        match self {
            Self::Npm { suffix, .. } => format!("{version}{suffix}"),
            Self::Release { .. } => format!("v{version}"),
        }
    }
}

impl Plugin {
    fn version(&self, cli: &Cli) -> Result<String> {
        match (self, cli.local, cli.plugin.as_deref()) {
            (_, true, _) => Ok("local".to_owned()),
            (Self::ClawHub(package), false, None) => clawhub_latest(package),
            (Self::ClawHub(_), false, Some(version)) => Ok(version.to_owned()),
            (Self::Tree(tree), false, None) => tree_version(tree),
            (Self::Tree(_), false, Some(_)) => {
                bail!("--plugin does not apply to an in-tree plugin")
            }
        }
    }

    fn stage(&self, local: bool) -> Option<&'static str> {
        match self {
            Self::ClawHub(_) => Some(if local { "local" } else { "clawhub" }),
            Self::Tree(_) => None,
        }
    }

    fn prepare(&self, dir: &Path, local: bool) -> Result<()> {
        let staged = dir.join(STAGED);
        fs::remove_dir_all(&staged).ok();
        match (self, local) {
            (Self::ClawHub(_), false) => Ok(()),
            (Self::ClawHub(_), true) => stage_clawhub(&staged),
            (Self::Tree(tree), true) => {
                copy_tree(&Path::new(IMAGES).join("..").join(tree), &staged)
            }
            (Self::Tree(tree), false) => archive(tree, &staged),
        }
    }
}

fn get<T: DeserializeOwned>(url: &str) -> Result<T> {
    Ok(ureq::get(url)
        .call()
        .with_context(|| url.to_owned())?
        .body_mut()
        .read_json()?)
}

fn npm_latest(package: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct DistTags {
        latest: String,
    }
    let tags: DistTags = get(&format!(
        "https://registry.npmjs.org/-/package/{package}/dist-tags"
    ))?;
    Ok(tags.latest)
}

fn github_latest(repo: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }
    let release: Release = get(&format!(
        "https://api.github.com/repos/{repo}/releases/latest"
    ))?;
    Ok(release.tag_name.trim_start_matches('v').to_owned())
}

fn clawhub_latest(package: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Response {
        package: Package,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Package {
        latest_version: String,
    }
    let body: Response = get(&format!("https://clawhub.ai/api/v1/packages/{package}"))?;
    Ok(body.package.latest_version)
}

fn tree_version(tree: &str) -> Result<String> {
    let manifest = Path::new(IMAGES).join("..").join(tree).join("plugin.yaml");
    let text =
        fs::read_to_string(&manifest).with_context(|| format!("read {}", manifest.display()))?;
    text.lines()
        .find_map(|line| line.strip_prefix("version:"))
        .and_then(|value| {
            let value = value.trim_start().trim_start_matches(['"', '\'']);
            value.split(['"', '\'', '#', ' ', '\t']).next()
        })
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("{} has no version", manifest.display()))
}

fn published(image: &str, tag: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct Token {
        token: String,
    }
    let (host, repo) = image
        .split_once('/')
        .context("image has no registry host")?;
    let (token, manifest) = match host {
        "ghcr.io" => (
            format!("https://ghcr.io/token?scope=repository:{repo}:pull&service=ghcr.io"),
            format!("https://ghcr.io/v2/{repo}/manifests/{tag}"),
        ),
        "docker.io" => (
            format!(
                "https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"
            ),
            format!("https://registry-1.docker.io/v2/{repo}/manifests/{tag}"),
        ),
        other => bail!("no registry rule for {other}"),
    };
    let auth: Token = get(&token)?;
    match ureq::head(&manifest)
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("Accept", MANIFEST_ACCEPT)
        .call()
    {
        Ok(_) => Ok(true),
        Err(ureq::Error::StatusCode(404)) => Ok(false),
        Err(error) => Err(error).context("registry manifest"),
    }
}

fn head() -> Result<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(IMAGES)
        .output()
        .context("git not found")?;
    if !out.status.success() {
        bail!("git rev-parse exited with {}", out.status);
    }
    Ok(String::from_utf8(out.stdout)?.trim().to_owned())
}

fn stage_clawhub(staged: &Path) -> Result<()> {
    let plugin = Path::new(IMAGES).join("../plugin");
    run("bun", ["install", "--frozen-lockfile"], &plugin)?;
    run("bun", ["run", "build"], &plugin)?;
    for (script, out) in [
        ("stage-channel.mjs", "channel"),
        ("stage-tools.mjs", "tools"),
    ] {
        run(
            "bun",
            [
                script.as_ref(),
                staged.join(out).as_os_str(),
                "--vendor-deps".as_ref(),
            ],
            &plugin,
        )?;
    }
    Ok(())
}

/// The committed plugin tree, so a published image never carries local edits.
/// `git archive` keeps only paths under its working directory, hence the repo root.
fn archive(tree: &str, staged: &Path) -> Result<()> {
    let tar = staged.with_file_name(ARCHIVE);
    let tree_ish = format!("HEAD:{tree}");
    let repo = Path::new(IMAGES).join("..");
    run(
        "git",
        [
            "archive".as_ref(),
            "--format=tar".as_ref(),
            "-o".as_ref(),
            tar.as_os_str(),
            tree_ish.as_ref(),
        ],
        &repo,
    )?;
    fs::create_dir_all(staged)?;
    run(
        "tar",
        [
            "-xf".as_ref(),
            tar.as_os_str(),
            "-C".as_ref(),
            staged.as_os_str(),
        ],
        &repo,
    )?;
    fs::remove_file(&tar).ok();
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from).with_context(|| format!("read {}", from.display()))? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if !entry.file_type()?.is_dir() {
            fs::copy(entry.path(), &target)?;
        } else if entry.file_name() != "__pycache__" {
            copy_tree(&entry.path(), &target)?;
        }
    }
    Ok(())
}

fn build(plan: &Plan, push: bool, digest: bool) -> Result<()> {
    let mut args = vec!["buildx".to_owned(), "build".to_owned()];
    let mut vars = vec![("BASE", plan.base.as_str())];
    vars.extend(plan.stage.map(|stage| ("PLUGIN_STAGE", stage)));
    vars.extend([
        ("ENGINE_VERSION", plan.engine.as_str()),
        ("PLUGIN_VERSION", plan.plugin.as_str()),
        ("IMAGE_VERSION", plan.version.as_str()),
    ]);
    for (key, value) in vars {
        args.push("--build-arg".to_owned());
        args.push(format!("{key}={value}"));
    }
    match digest {
        true => args.extend([
            "--output".to_owned(),
            format!(
                "type=image,name={},push-by-digest=true,push=true",
                plan.repo
            ),
        ]),
        false => {
            args.extend(["-t".to_owned(), plan.image.clone()]);
            args.push(if push { "--push" } else { "--load" }.to_owned());
        }
    }
    if push {
        args.extend(["--metadata-file".to_owned(), METADATA.to_owned()]);
    }
    args.push(".".to_owned());
    run("docker", args, &plan.dir)?;

    if !push {
        println!("\n  loaded   {}", plan.image);
        return Ok(());
    }

    #[derive(Deserialize)]
    struct Metadata {
        #[serde(rename = "containerimage.digest")]
        digest: String,
    }
    let path = plan.dir.join(METADATA);
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let meta: Metadata = serde_json::from_str(&raw).context("buildx metadata")?;
    fs::remove_file(&path).ok();
    println!("\n  pushed   {}@{}", plan.repo, meta.digest);
    Ok(())
}

fn run(program: &str, args: impl IntoIterator<Item = impl AsRef<OsStr>>, cwd: &Path) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .status()
        .with_context(|| format!("{program} not found"))?;
    if !status.success() {
        bail!("{program} exited with {status}");
    }
    Ok(())
}

fn ask(prompt: &str) -> Result<String> {
    print!("  {prompt}: ");
    stdout().flush()?;
    let mut line = String::new();
    stdin().read_line(&mut line)?;
    Ok(line.trim().to_owned())
}
