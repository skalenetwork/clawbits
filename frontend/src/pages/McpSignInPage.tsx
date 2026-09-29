import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import RequireAuth from "@/components/RequireAuth";
import { SetupButton, SetupPanel, SetupStage } from "@/components/setup/SetupShell";
import { completeMcpSignIn } from "@/lib/api";
import { isDesktop, nativeScheme } from "@/lib/desktop";
import { errMsg } from "@/lib/toast";

/** The provider's return: native clients get it handed back to their app, the web relays the code here. */
export default function McpSignInPage() {
  const [params] = useSearchParams();
  const [grant] = useState(() => new URLSearchParams(params));
  const state = grant.get("state") ?? "";
  const scheme = isDesktop ? undefined : nativeScheme(state);
  return scheme ? (
    <HandOff href={`${scheme}://mcp-callback?${grant.toString()}`} />
  ) : (
    <RequireAuth>
      <Finish state={state} code={grant.get("code") ?? ""} />
    </RequireAuth>
  );
}

function HandOff({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return (
    <SetupStage>
      <SetupPanel title="Back to Clawbits" line="The app finishes the sign-in. You can close this tab.">
        <SetupButton onClick={() => { window.location.replace(href); }}>Open Clawbits</SetupButton>
      </SetupPanel>
    </SetupStage>
  );
}

function Finish({ state, code }: { state: string; code: string }) {
  const navigate = useNavigate();
  const [failure, setFailure] = useState(code ? "" : "The provider declined the sign-in.");
  const started = useRef(false);

  useEffect(() => {
    void navigate({ search: "" }, { replace: true });
    if (started.current || !code) return;
    started.current = true;
    completeMcpSignIn(state, code).then(
      ({ channel_id }) => void navigate(`/channels/${channel_id}`, { replace: true }),
      (err: unknown) => {
        setFailure(errMsg(err, "The sign-in failed."));
      },
    );
  }, [code, navigate, state]);

  return (
    <SetupStage>
      <SetupPanel
        title={failure ? "Sign-in failed" : "Connecting"}
        line={failure || "Handing the sign-in to your agent."}
      >
        {failure && <SetupButton onClick={() => void navigate("/home")}>Back to Clawbits</SetupButton>}
      </SetupPanel>
    </SetupStage>
  );
}
