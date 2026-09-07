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
const METADATA: &str = ".metadata.json";
const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, \
     application/vnd.docker.distribution.manifest.list.v2+json, \
     application/vnd.oci.image.manifest.v1+json, \
     application/vnd.docker.distribution.manifest.v2+json";

struct Recipe {
    name: &'static str,
    repo: &'static str,
    tag: (&'static str, &'static str),
    npm: &'static str,
    ghcr: &'static str,
    variant: &'static str,
    clawhub: &'static str,
}

const RECIPES: &[Recipe] = &[Recipe {
    name: "openclaw",
    repo: "ghcr.io/skalenetwork/clawbits-openclaw",
    tag: ("oc", "pl"),
    npm: "openclaw",
    ghcr: "openclaw/openclaw",
    variant: "-browser",
    clawhub: "clawbits-openclaw-plugin",
}];

struct Plan {
    dir: PathBuf,
    repo: &'static str,
    image: String,
    version: String,
    base: String,
    engine: String,
    plugin: String,
    stage: &'static str,
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
    let plan = resolve(pick(cli.image.as_deref())?, &cli)?;

    println!("  engine   {:<12} {}", plan.engine, plan.base);
    println!("  plugin   {}", plan.plugin);
    println!("  image    {}\n", plan.image);
    if !cli.yes && stdin().is_terminal() && !matches!(ask("build? [Y/n]")?.as_str(), "" | "y" | "Y")
    {
        return Ok(());
    }

    if cli.local {
        stage_plugin(&plan.dir)?;
    }
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
        None => npm_latest(recipe.npm)?,
    };
    let tag = format!("{engine}{}", recipe.variant);
    if !ghcr_has(recipe.ghcr, &tag)? {
        bail!(
            "ghcr.io/{}:{tag} is not published; pass --engine <version>",
            recipe.ghcr
        );
    }

    let plugin = match (cli.local, &cli.plugin) {
        (true, _) => "local".to_owned(),
        (false, Some(version)) => version.clone(),
        (false, None) => clawhub_latest(recipe.clawhub)?,
    };

    let (e, p) = recipe.tag;
    let version = match cli.local {
        true => format!("{e}{engine}-local"),
        false => format!("{e}{engine}-{p}{plugin}"),
    };
    Ok(Plan {
        dir: Path::new(IMAGES).join(recipe.name),
        repo: recipe.repo,
        image: format!("{}:{version}", recipe.repo),
        version,
        base: format!("ghcr.io/{}:{tag}", recipe.ghcr),
        engine,
        plugin,
        stage: if cli.local { "local" } else { "clawhub" },
    })
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

fn ghcr_has(repo: &str, tag: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct Token {
        token: String,
    }
    let auth: Token = get(&format!(
        "https://ghcr.io/token?scope=repository:{repo}:pull&service=ghcr.io"
    ))?;
    match ureq::head(&format!("https://ghcr.io/v2/{repo}/manifests/{tag}"))
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("Accept", MANIFEST_ACCEPT)
        .call()
    {
        Ok(_) => Ok(true),
        Err(ureq::Error::StatusCode(404)) => Ok(false),
        Err(error) => Err(error).context("ghcr manifest"),
    }
}

fn stage_plugin(dir: &Path) -> Result<()> {
    let plugin = Path::new(IMAGES).join("../plugin");
    let staged = dir.join(STAGED);
    fs::remove_dir_all(&staged).ok();
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

fn build(plan: &Plan, push: bool, digest: bool) -> Result<()> {
    let mut args = vec!["buildx".to_owned(), "build".to_owned()];
    for (key, value) in [
        ("BASE", plan.base.as_str()),
        ("PLUGIN_STAGE", plan.stage),
        ("ENGINE_VERSION", &plan.engine),
        ("PLUGIN_VERSION", &plan.plugin),
        ("IMAGE_VERSION", &plan.version),
    ] {
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
