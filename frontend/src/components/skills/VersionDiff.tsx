import {useQuery} from "@tanstack/react-query";
import {Skeleton} from "@/components/ui/skeleton";
import {useAuth} from "@/context/AuthContext";
import {getSkillVersion, type SkillVersion, type SkillVersionDetail} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {diffLines} from "@/lib/skills";
import {errMsg} from "@/lib/toast";
import {cn} from "@/lib/utils";

const LINE = "grid min-h-5 grid-cols-[28px_minmax(0,1fr)] pr-3";

const MARK = {
    same: {glyph: "", tone: ""},
    add: {glyph: "+", tone: "text-emerald-700 dark:text-emerald-400"},
    del: {glyph: "-", tone: "text-destructive"},
};

const versionText = (v: SkillVersionDetail) => `description: ${v.manifest.description}\n\n${v.body_md}`;

/** What one version changed against the one before it: the description the model reads first, then the instructions.
 *  The meaning sits in the +/- gutter, never in a row tint. Versions are immutable, so each is fetched once. */
export function VersionDiff({skillId, versionId, previous}: {skillId: string; versionId: string; previous: SkillVersion}) {
    const {activeOrgId} = useAuth();
    const orgId = activeOrgId ?? "";
    const detail = (id: string) => ({
        queryKey: queryKeys.skillVersion(orgId, skillId, id),
        queryFn: () => getSkillVersion(orgId, skillId, id),
        staleTime: Infinity,
    });
    const after = useQuery(detail(versionId));
    const before = useQuery(detail(previous.version_id));

    if (after.isPending || before.isPending) return <Skeleton className="mx-4 mb-4 h-24 rounded-[10px]"/>;
    if (after.isError || before.isError) {
        return (
            <p className="mx-4 mb-4 font-mono text-[12.5px] text-destructive wrap-anywhere">
                {errMsg(after.error ?? before.error)}
            </p>
        );
    }

    const rows = diffLines(versionText(before.data), versionText(after.data));
    const count = (kind: "add" | "del") => rows.filter(row => row.kind === kind).length;
    return (
        <div
            role="region"
            aria-label={`Changes in v${after.data.version}`}
            className="mx-4 mb-4 overflow-hidden rounded-[10px] border border-code-border bg-code"
        >
            <div className="flex justify-between gap-3 border-b border-code-border px-3 py-2 text-[12px] text-muted-foreground tabular-nums">
                <span>Compared with v{previous.version}</span>
                <span>{count("add")} added, {count("del")} removed</span>
            </div>
            {rows.every(row => row.kind === "gap") ? (
                <p className="px-3 py-2 text-[12px] text-muted-foreground">No change to the description or instructions.</p>
            ) : (
                <div className="py-1 font-mono text-[12.5px] leading-5">
                    {rows.map((row, i) => row.kind === "gap" ? (
                        <div key={i} className={cn(LINE, "py-1 font-sans text-[12px] text-muted-foreground")}>
                            <span/>
                            <span>{row.lines} unchanged line{row.lines === 1 ? "" : "s"}</span>
                        </div>
                    ) : (
                        <div
                            key={i}
                            className={cn(LINE, "whitespace-pre-wrap wrap-anywhere", row.kind === "del" && "text-muted-foreground")}
                        >
                            <span className={cn("text-center select-none", MARK[row.kind].tone)}>{MARK[row.kind].glyph}</span>
                            <span>{row.text}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
