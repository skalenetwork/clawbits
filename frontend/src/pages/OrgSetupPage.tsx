/** Which org to open: asked once per sign-in of someone in several, or opened
 *  on purpose to switch. Picking opens it and forwards to ``next``. */
import { useEffect, useEffectEvent, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Avatar } from "@/components/Avatar";
import { SetupChoice, SetupCornerButton, SetupPanel, SetupStage } from "@/components/setup/SetupShell";
import { useAuth } from "@/context/AuthContext";
import { orgScoped, useOpenOrg } from "@/hooks/useOpenOrg";
import { getOrgs, type Org } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { DEFAULT_LANDING, NEXT_PARAM, safeReturnPath } from "@/lib/returnPath";

function orgMeta(org: Org): string {
  if (org.is_personal) return "Personal";
  return org.my_role === "owner" ? "Owner" : "Member";
}

export default function OrgSetupPage() {
  const { activeOrgId, needsOrgPick, logout } = useAuth();
  const navigate = useNavigate();
  const openOrg = useOpenOrg();
  const [params] = useSearchParams();
  const orgs = useQuery({ queryKey: queryKeys.orgs, queryFn: getOrgs }).data?.organizations ?? [];
  const [flashed, setFlashed] = useState<number | null>(null);
  const next = safeReturnPath(params.get(NEXT_PARAM)) ?? DEFAULT_LANDING;

  const leave = (to: string) => {
    void navigate(to, { replace: true });
  };

  const pick = (i: number) => {
    const org = orgs[i];
    if (!org || flashed !== null) return;
    setFlashed(i);
    setTimeout(() => {
      if (needsOrgPick || org.org_id !== activeOrgId) openOrg(org.org_id);
      leave(!needsOrgPick && org.org_id !== activeOrgId && orgScoped(next) ? DEFAULT_LANDING : next);
    }, 200);
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.repeat) return;
    if (e.key === "Escape" && !needsOrgPick) leave(next);
    else if (/^[1-9]$/.test(e.key)) pick(Number(e.key) - 1);
    else return;
    e.preventDefault();
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <SetupStage>
      {needsOrgPick ? (
        <SetupCornerButton
          onClick={() => {
            void logout().then(() => {
              leave("/login");
            });
          }}
        >
          Sign out
        </SetupCornerButton>
      ) : (
        <SetupCornerButton
          chip="Esc"
          onClick={() => {
            leave(next);
          }}
        >
          Exit
        </SetupCornerButton>
      )}
      <SetupPanel
        title="Pick an organization"
        line={needsOrgPick ? "You can switch any time from the profile menu." : undefined}
      >
        <div className="flex w-full flex-col gap-2">
          {orgs.map((org, i) => {
            const unread = org.unread_count ?? 0;
            return (
              <SetupChoice
                key={org.org_id}
                icon={<Avatar src={org.avatar?.url} name={org.display_name ?? org.name} size={40} className="rounded-[10px]" />}
                title={org.display_name ?? org.name}
                meta={orgMeta(org)}
                digit={i + 1}
                picked={flashed === i}
                onPick={() => {
                  pick(i);
                }}
              >
                {!needsOrgPick && org.org_id === activeOrgId ? (
                  <span className="rounded-full bg-foreground/6 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Current
                  </span>
                ) : unread > 0 ? (
                  <span className="rounded-full bg-unread px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
                    {unread > 99 ? "99+" : unread}
                  </span>
                ) : (
                  org.last_visited_at == null && (
                    <span className="rounded-full bg-foreground/6 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      New
                    </span>
                  )
                )}
              </SetupChoice>
            );
          })}
        </div>
      </SetupPanel>
    </SetupStage>
  );
}
