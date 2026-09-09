/**
 * Settings → Reef. One org, one private repository, and the hosts pulling from
 * it.
 *
 * Git is the bus: Clawbits writes a file per agent to the `fleet` branch and
 * reads what each host pushes to `status`. It never talks to a host and nothing
 * on the network reaches one — which is why this page has no "add host" button.
 * A host exists when its status file does, so the empty state below the
 * connection IS the host setup: connect first, stand a host up second.
 */
import {useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    CheckmarkCircle02Icon as CheckCircle,
    GithubIcon as Github,
    ServerStack01Icon as ServerStack,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {confirm} from "@/lib/confirm";
import {deleteReef, getReef, setReef, type ReefHost} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";

/** A host is expected to push every 30 seconds. Past this its reconciler has
 *  stopped, or it cannot reach the repository. */
const STALE_AFTER_MS = 3 * 60_000;

const TOKEN_URL =
    "https://github.com/settings/personal-access-tokens/new";

export default function SettingsReefPage() {
    const {activeOrgId} = useAuth();
    const {isOwner} = useActiveOrg();
    const queryClient = useQueryClient();

    const reefQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.reef(activeOrgId) : ["org", "none", "reef"],
        queryFn: () => getReef(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
        // Hosts push every 30s; this is the page that shows whether they still do.
        refetchInterval: 30_000,
        refetchIntervalInBackground: true,
    });
    const reef = reefQuery.data;

    const disconnect = useMutation({
        mutationFn: () => deleteReef(activeOrgId ?? ""),
        onSuccess: () => {
            if (activeOrgId) void queryClient.invalidateQueries({queryKey: queryKeys.reef(activeOrgId)});
            toast.success("Repository disconnected");
        },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    return (
        <div className="divide-y divide-border/60">
            <PageHeader icon={ServerStack} title="Reef"/>

            <section className="space-y-5 py-8 first:pt-0">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">Repository</h2>
                    <p className="text-xs text-muted-foreground">
                        One private repository your org shares with its own hardware. Clawbits
                        writes a file per agent; your hosts pull it. Nothing ever connects to
                        your machines.
                    </p>
                </div>

                {reefQuery.isLoading ? (
                    <div className="h-[86px] animate-pulse rounded-xl border border-border/50 bg-muted/30"/>
                ) : reefQuery.isError ? (
                    <p className="text-sm text-destructive">
                        {errMsg(reefQuery.error, "Couldn't load the reef settings")}
                    </p>
                ) : reef?.connected ? (
                    <ConnectedCard
                        repo={reef.repo ?? ""}
                        canDisconnect={isOwner}
                        disconnecting={disconnect.isPending}
                        onDisconnect={() => {
                            void (async () => {
                                const ok = await confirm({
                                    title: "Disconnect the repository?",
                                    description: "Agents already declared keep running — their files stay on the branch. Clawbits just stops reading and writing it.",
                                    confirmLabel: "Disconnect",
                                    destructive: true,
                                });
                                if (ok) disconnect.mutate();
                            })();
                        }}
                    />
                ) : isOwner ? (
                    <ConnectForm orgId={activeOrgId} storedRepo={reef?.repo ?? null}/>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        No repository is connected. An organization admin can connect one.
                    </p>
                )}
            </section>

            {reef?.connected && (
                <section className="space-y-5 py-8">
                    <div className="space-y-0.5">
                        <h2 className="text-sm font-semibold">
                            Hosts{reef.hosts.length > 0 && ` · ${String(reef.hosts.length)}`}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            A host appears here once its reconciler pushes for the first time.
                        </p>
                    </div>
                    {reef.hosts.length === 0 ? (
                        <HostSetup repo={reef.repo ?? "ORG/REPO"}/>
                    ) : (
                        <div className="grid gap-3 lg:grid-cols-2">
                            {reef.hosts.map((h) => <HostCard key={h.host} host={h}/>)}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}

/** First run. The token is proven against GitHub before anything is stored, so
 *  a bad one fails here rather than silently on the first agent. */
function ConnectForm({orgId, storedRepo}: {orgId: string; storedRepo: string | null}) {
    const queryClient = useQueryClient();
    const [repo, setRepo] = useState(storedRepo ?? "");
    const [token, setToken] = useState("");

    const connect = useMutation({
        mutationFn: () => setReef(orgId, repo.trim(), token.trim()),
        onSuccess: () => {
            void queryClient.invalidateQueries({queryKey: queryKeys.reef(orgId)});
            setToken("");
            toast.success("Repository connected");
        },
    });

    const validRepo = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo.trim());
    const ready = validRepo && token.trim().length > 0 && !connect.isPending;

    return (
        <form
            className="space-y-5 rounded-xl border border-border/50 bg-card p-5"
            onSubmit={(e) => {
                e.preventDefault();
                if (ready) connect.mutate();
            }}
        >
            {storedRepo !== null && (
                <p className="text-[13px] text-amber-600 dark:text-amber-400">
                    {storedRepo} is stored, but its token can no longer be read. Enter a new one.
                </p>
            )}
            <div className="space-y-2">
                <label htmlFor="reef-repo" className="text-[13px] font-medium">Repository</label>
                <Input
                    id="reef-repo"
                    value={repo}
                    onChange={(e) => { setRepo(e.target.value); }}
                    placeholder="acme/agents"
                    autoComplete="off"
                    spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                    A private repository on github.com, as <code>owner/name</code>. It needs
                    three branches — <code>main</code>, <code>fleet</code> and{" "}
                    <code>status</code> — and nothing else.
                </p>
            </div>
            <div className="space-y-2">
                <label htmlFor="reef-token" className="text-[13px] font-medium">Access token</label>
                <Input
                    id="reef-token"
                    type="password"
                    value={token}
                    onChange={(e) => { setToken(e.target.value); }}
                    placeholder="github_pat_…"
                    autoComplete="off"
                    spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                    A{" "}
                    <a
                        href={TOKEN_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2 hover:text-foreground"
                    >
                        fine-grained token
                    </a>{" "}
                    scoped to this one repository, with <strong>Contents: read and write</strong>.
                    It is encrypted at rest and never leaves the server.
                </p>
            </div>
            {connect.isError && (
                <p className="text-[13px] text-destructive">
                    {errMsg(connect.error, "Couldn't reach that repository")}
                </p>
            )}
            <Button type="submit" disabled={!ready}>
                {connect.isPending ? "Checking…" : "Connect"}
            </Button>
        </form>
    );
}

function ConnectedCard({
    repo,
    canDisconnect,
    disconnecting,
    onDisconnect,
}: {
    repo: string;
    canDisconnect: boolean;
    disconnecting: boolean;
    onDisconnect: () => void;
}) {
    return (
        <div className="flex items-center gap-3.5 rounded-xl border border-border/50 bg-card px-4 py-3.5">
            <Icon icon={Github} className="size-5 shrink-0 text-muted-foreground"/>
            <div className="min-w-0 flex-1">
                <a
                    href={`https://github.com/${repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sm font-medium underline-offset-2 hover:underline"
                >
                    {repo}
                </a>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                    <Icon icon={CheckCircle} className="size-3.5"/>
                    Connected
                </p>
            </div>
            {canDisconnect && (
                <Button variant="ghost" size="sm" disabled={disconnecting} onClick={onDisconnect}>
                    Disconnect
                </Button>
            )}
        </div>
    );
}

function HostCard({host}: {host: ReefHost}) {
    const seen = host.last_seen ? new Date(host.last_seen) : null;
    const stale = seen === null || Date.now() - seen.getTime() > STALE_AFTER_MS;
    return (
        <div className="rounded-xl border border-border/50 bg-card p-4">
            <div className="flex items-center gap-2.5">
                <span
                    className={cn(
                        "size-2 shrink-0 rounded-full",
                        stale ? "bg-amber-500" : "bg-emerald-500",
                    )}
                />
                <span className="min-w-0 truncate text-sm font-semibold">{host.host}</span>
                {host.reef && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        reef {host.reef}
                    </span>
                )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
                {host.agents === 1 ? "1 agent" : `${String(host.agents)} agents`}
                {" · "}
                {stale
                    ? seen === null
                        ? "never reported"
                        : `last reported ${relative(seen)} — its reconciler has stopped`
                    : `reported ${relative(seen)}`}
            </p>
        </div>
    );
}

/** The empty state IS the host setup: there is no way to add a host from here,
 *  because nothing here can reach one. */
function HostSetup({repo}: {repo: string}) {
    const steps: {title: string; body: string; code?: string}[] = [
        {
            title: "Prepare the machine",
            body: "Install reef and microsandbox, and run it as its own account. reef.clawbits.ai/docs/setup/host covers KVM, the msb pin and the state directory.",
        },
        {
            title: "Give it a deploy key",
            body: "Write access — it has to push its status. Add the printed key to the repository's deploy keys.",
            code: `ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C "reef@$(hostname)"\ncat ~/.ssh/id_ed25519.pub`,
        },
        {
            title: "Clone the three branches",
            body: "One clone each, so the timer only ever needs a fast-forward pull.",
            code: `mkdir -p ~/agents\nfor branch in main fleet status; do\n  git clone --branch "$branch" --single-branch git@github.com:${repo}.git ~/agents/"$branch"\ndone\nprintf 'version = 1\\n' > ~/agents/empty.toml`,
        },
        {
            title: "Start the timer",
            body: "Every 30 seconds it pulls, applies what changed, and pushes what it sees. Name the host here — that name is what people pick when they create an agent.",
            code: "sudo systemctl edit reef-reconcile.service   # Environment=REEF_HOST=prod-eu\nsudo systemctl enable --now reef-reconcile.timer",
        },
    ];
    return (
        <div className="space-y-5 rounded-xl border border-dashed border-border bg-muted/20 p-5">
            <p className="text-[13px] text-muted-foreground">
                No host has reported yet. Stand one up and it appears here on its own — this
                page never reaches out to it.
            </p>
            <ol className="space-y-4">
                {steps.map((step, i) => (
                    <li key={step.title} className="flex gap-3.5">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[11px] font-semibold">
                            {i + 1}
                        </span>
                        <div className="min-w-0 flex-1 space-y-2">
                            <p className="text-[13px] font-medium">{step.title}</p>
                            <p className="text-xs text-muted-foreground">{step.body}</p>
                            {step.code && <CodeBlock code={step.code}/>}
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function CodeBlock({code}: {code: string}) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="group relative">
            <pre className="overflow-x-auto rounded-lg border border-border/60 bg-background/60 px-3 py-2.5 text-[11.5px] leading-relaxed">
                <code>{code}</code>
            </pre>
            <Button
                variant="ghost"
                size="sm"
                className="absolute top-1.5 right-1.5 h-6 px-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => {
                    void navigator.clipboard.writeText(code);
                    setCopied(true);
                }}
            >
                {copied ? "Copied" : "Copy"}
            </Button>
        </div>
    );
}

function relative(at: Date): string {
    const seconds = Math.round((Date.now() - at.getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${String(minutes)}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${String(hours)}h ago`;
    return `${String(Math.round(hours / 24))}d ago`;
}
