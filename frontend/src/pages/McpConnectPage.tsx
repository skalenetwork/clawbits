import { useParams } from "react-router-dom";
import { McpConnectCard } from "@/components/McpConnectCard";
import { SetupStage } from "@/components/setup/SetupShell";

export default function McpConnectPage() {
  const { linkId = "" } = useParams();
  return (
    <SetupStage>
      <McpConnectCard linkId={linkId} />
    </SetupStage>
  );
}
