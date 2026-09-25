import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { SetupButton, SetupPanel, SetupStage } from "@/components/setup/SetupShell";
import { completeMcpSignIn } from "@/lib/api";
import { errMsg } from "@/lib/toast";

type Panel = { title: string; line: string; action?: string; to?: string };

const failed = (line: string): Panel => ({ title: "Sign-in failed", line, action: "Back to Clawbits", to: "/home" });

export default function McpSignInPage() {
  const navigate = useNavigate();
  const { agentId = "", server = "" } = useParams();
  const [params] = useSearchParams();
  const [panel, setPanel] = useState<Panel>({ title: "Connecting", line: "Finishing the sign-in with your agent." });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const state = params.get("state");
    const code = params.get("code");
    void navigate({ search: "" }, { replace: true });
    if (!state || !code) return setPanel(failed("The provider declined the sign-in."));
    completeMcpSignIn(agentId, server, state, code).then(
      ({ agent_name, channel_id }) =>
        setPanel({
          title: "Connected",
          line: `${agent_name} can use ${server} now.`,
          action: "Return to the chat",
          to: `/channels/${channel_id}`,
        }),
      (err: unknown) => setPanel(failed(errMsg(err, "The sign-in failed."))),
    );
  }, [agentId, navigate, params, server]);

  const { title, line, action, to } = panel;
  return (
    <SetupStage>
      <SetupPanel title={title} line={line}>
        {to && <SetupButton onClick={() => void navigate(to)}>{action}</SetupButton>}
      </SetupPanel>
    </SetupStage>
  );
}
