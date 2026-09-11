/**
 * Reef setup, full screen.
 *
 * Three screens, because that is how many decisions there are: point it at a
 * repository, name the machine, wait for the machine to answer. Arrival is a
 * state of the waiting screen rather than a screen of its own, so the page it
 * settles into is the page you were already looking at.
 */
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Checks,
  CommandBlock,
  SetupButton,
  SetupField,
  SetupMark,
  SetupPanel,
  SetupShell,
} from "@/components/setup/SetupShell";
import { useAuth } from "@/context/AuthContext";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { getReef, setReef } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

const ICON = {
  repo: "/github.webp",
  key: "/key.webp",
  host: "/server.webp",
  machine: "/computer.webp",
  reef: "/reef-dark.webp",
  waiting: "/waiting.webp",
  reporting: "/reporting.webp",
};

/** reef's own rule (crates/reef-core/src/name.rs): 1-40, starts lowercase, no
 *  trailing hyphen. Enforced here so a bad name fails in the field rather than
 *  showing up green on a host that can never receive an agent. */
const HOST_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** Served from the public repo, not from this app: the command is pasted into
 *  a shell on another machine, where this app's origin does not resolve. */
const BOOTSTRAP =
  "https://raw.githubusercontent.com/skalenetwork/clawbits/main/reef/bootstrap.sh";

const REPO_NOTE = "A private repo to store Reef state.";

/** Nobody types `owner/name`, they paste what is in the address bar. Take the
 *  URL, the `.git` clone string, or the bare pair, and keep the pair. */
function normalizeRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

type Step = 0 | 1 | 2;

export default function ReefSetupPage() {
  const { activeOrgId } = useAuth();
  const { org, isOwner, isLoading } = useActiveOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const replacing = params.get("replace") === "1";
  const [step, setStep] = useState<Step>(0);
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [host, setHost] = useState("");
  const [showWhy, setShowWhy] = useState(false);

  // Needed from step 1 on: to resume an unfinished setup, to fill the command
  // block with the stored repo, and to watch for the host.
  const reef = useQuery({
    queryKey: activeOrgId ? queryKeys.reef(activeOrgId) : ["org", "none", "reef"],
    queryFn: () => getReef(activeOrgId ?? ""),
    enabled: Boolean(activeOrgId) && (step > 0 || Boolean(org?.reef_connected)),
    refetchInterval: step === 2 ? 15_000 : false,
  });

  // The server's `connected` is the authority on resume and the org flag is
  // not: a rotated secrets key leaves the flag true while the token can no
  // longer be unsealed, and that case has to land on step 0 with the repo
  // already filled in, because a new token is the only fix. `?replace=1` asks
  // for that same screen on purpose.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || step !== 0 || !reef.data) return;
    if (repo || token) return;
    resumed.current = true;
    if (reef.data.connected && !replacing) setStep(1);
    else if (reef.data.repo) setRepo(reef.data.repo);
  }, [reef.data, step, repo, token, replacing]);

  const trimmedRepo = repo.trim();
  const typed = normalizeRepo(repo);
  const repoOk = REPO_RE.test(typed);
  const tokenOk = token.trim().length > 0;
  const hostName = host.trim();
  const hostOk = HOST_RE.test(hostName);
  /** For display only. Never used to decide whether the form may be submitted. */
  const repoPair = typed || (reef.data?.repo ?? "");
  /** Stored, but its token cannot be read. Only a new token clears it. */
  const needsToken = Boolean(reef.data && !reef.data.connected && reef.data.repo);

  const connect = useMutation({
    mutationFn: () => setReef(activeOrgId ?? "", typed, token.trim()),
    onSuccess: () => {
      if (!replacing) {
        setStep(1);
        return;
      }
      if (activeOrgId) void queryClient.invalidateQueries({ queryKey: queryKeys.reef(activeOrgId) });
      void navigate("/settings/reef", { replace: true });
    },
    onError: (e) => {
      toast.error(errMsg(e, "Couldn't connect that repository"));
    },
  });

  const repoNote =
    !trimmedRepo || (repoOk && typed === trimmedRepo)
      ? REPO_NOTE
      : repoOk
        ? `Using ${typed}`
        : "That does not look like a GitHub repository.";

  const arrived = reef.data?.hosts.find((h) => h.host === hostName) ?? null;

  // Steps 0 and 1 are forms, so Enter is native there; the arrival screen is
  // not, so its primary action is bound here.
  const back: Step | null = step === 1 ? 0 : step === 2 && !arrived ? 1 : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (e.key === "Enter" && step === 2 && arrived) {
        e.preventDefault();
        void navigate("/setup/agent", { replace: true });
      } else if (e.key === "Escape" && back !== null) {
        e.preventDefault();
        setStep(back);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [step, back, arrived, navigate]);

  if (isLoading) return null;
  if (!isOwner) return <Navigate to="/home" replace />;

  const steps = [
    { icon: ICON.repo, value: step > 0 ? repoPair.split("/").pop() : null },
    { icon: ICON.host, value: step > 1 ? hostName : null },
    { icon: ICON.reef, value: arrived ? "Reporting" : null },
  ];

  return (
    <SetupShell
      escExits={back === null}
      unsaved={step === 0 && token.trim() ? "The token you entered isn't saved yet." : null}
      steps={steps}
      at={step}
      onExit={() => {
        void navigate("/settings/reef");
      }}
    >
      {step === 0 && (
        <SetupPanel
          icon={<SetupMark src={ICON.reef} size={84} />}
          title={needsToken || replacing ? "Reconnect Reef store repo" : "Connect Reef store repo"}
          line={
            needsToken ? "The stored token can no longer be read. Enter a new one." : undefined
          }
        >
          <form
            className="flex w-full flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              // Never a disabled submit: the button always presses and the
              // field answers back, so a rejected value cannot be mistaken for
              // a broken page.
              if (!repoOk || !tokenOk) {
                setShowWhy(true);
                return;
              }
              connect.mutate();
            }}
          >
            <SetupField
              icon={ICON.repo}
              value={repo}
              onChange={setRepo}
              placeholder="owner/repository"
              note={repoNote}
              more={[
                "Needs three branches: main, fleet and status",
                "main holds the roles your team reviews",
                "Clawbits writes one file per agent to fleet",
                "Your machines report back on status",
                "Must be private: fleet files carry one-time tokens",
              ]}
              tone={(showWhy || trimmedRepo) && !repoOk ? "bad" : "muted"}
              autoFocus
            />
            <SetupField
              icon={ICON.key}
              secret
              note="A fine-grained token with Contents: read and write."
              more={[
                "Settings → Developer settings → Personal access tokens → Fine-grained",
                "Scope it to this one repository",
                "Grant Contents: read and write, nothing else",
                "On an org-owned repo, an owner may need to approve it first",
              ]}
              tone={showWhy && !tokenOk ? "bad" : "muted"}
              value={token}
              onChange={setToken}
              placeholder="github_pat_…"
            />
            <div className="mt-1 w-full">
              <SetupButton type="submit" chip="Enter" disabled={connect.isPending}>
                {connect.isPending ? "Checking…" : "Connect"}
              </SetupButton>
            </div>
          </form>
        </SetupPanel>
      )}

      {step === 1 && (
        <SetupPanel icon={<SetupMark src={ICON.host} size={84} />} title="Name the machine">
          <form
            className="flex w-full flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (hostOk) setStep(2);
            }}
          >
            <SetupField
              icon={ICON.machine}
              value={host}
              onChange={setHost}
              placeholder="prod-eu"
              note={
                hostName && !hostOk
                  ? "Lowercase letters, digits and hyphens only."
                  : "This becomes a folder in the repo, so it is permanent."
              }
              more={[
                "Names the folder under fleet/ and the file under status/",
                "Renaming later orphans everything already declared",
                "Starts with a lowercase letter",
                "Digits and hyphens are fine, no dots, underscores or capitals",
              ]}
              tone={hostName && !hostOk ? "bad" : "muted"}
              autoFocus
            />
            {/* The negative margin cancels the form's gap: a collapsed
                disclosure still takes one on each side. */}
            <div className="disclosure -mt-5" data-open={Boolean(hostName)}>
              <div className="disclosure-inner">
                <div className="pt-5">
                  <p className="mb-2 px-1 text-[13px] text-muted-foreground">
                    Run this on {hostName}:
                  </p>
                  <CommandBlock
                    code={
                      `curl -fsSL https://reef.clawbits.ai/install | sh\n` +
                      `curl -fsSL ${BOOTSTRAP} |\n  REEF_HOST=${hostName} REEF_REPO=${repoPair} sh`
                    }
                  />
                  <p className="mt-2 px-1 text-[13px] text-muted-foreground">
                    The first run prints a deploy key to add to the repo.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex w-full gap-2">
              <SetupButton
                variant="ghost"
                chip="Esc"
                onClick={() => {
                  setStep(0);
                }}
              >
                Back
              </SetupButton>
              <SetupButton type="submit" chip="Enter" disabled={!hostName}>
                Done
              </SetupButton>
            </div>
          </form>
        </SetupPanel>
      )}

      {step === 2 && (
        <SetupPanel
          icon={<SetupMark src={arrived ? ICON.reporting : ICON.waiting} size={84} />}
          title={arrived ? `${hostName} is reporting` : `Waiting for ${hostName}`}
          line={
            arrived ? "Agents you create now run on it." : "Your machine pulls every 30 seconds."
          }
        >
          {arrived ? (
            <div className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left">
              <SetupMark src={ICON.machine} size={42} />
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold">{arrived.host}</span>
                <span className="block text-[13px] text-muted-foreground">
                  {arrived.reef ? `reef ${arrived.reef} · ` : ""}
                  {arrived.agents.length} agent{arrived.agents.length === 1 ? "" : "s"}
                </span>
              </span>
            </div>
          ) : (
            <Checks
              items={[
                { label: "Repository connected", done: true },
                { label: "First report", done: false },
              ]}
            />
          )}
          <div className="flex w-full gap-2">
            {!arrived && (
              <SetupButton
                variant="ghost"
                chip="Esc"
                onClick={() => {
                  setStep(1);
                }}
              >
                Show the command
              </SetupButton>
            )}
            <SetupButton
              disabled={!arrived}
              chip={arrived ? "Enter" : undefined}
              onClick={() => {
                void navigate("/setup/agent", { replace: true });
              }}
            >
              Create agent
            </SetupButton>
          </div>
        </SetupPanel>
      )}
    </SetupShell>
  );
}
