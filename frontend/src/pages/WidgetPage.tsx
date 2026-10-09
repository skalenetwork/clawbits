import { Link, useParams } from "react-router-dom";
import { ChessPawnIcon } from "@hugeicons/core-free-icons";
import { PageHeader } from "@/components/PageHeader";
import { WidgetCard } from "@/components/widgets/WidgetCard";
import { useAuth } from "@/context/AuthContext";
import { useWidget, useWidgetLive } from "@/hooks/useWidget";

/** A widget on its own page: where the link in its message leads clients that can't draw it inline. */
export default function WidgetPage() {
  const { widgetId = "" } = useParams<{ widgetId: string }>();
  const { user } = useAuth();
  const { data: widget } = useWidget(widgetId);
  useWidgetLive(widgetId, widget?.channel_id);
  return (
    <>
      <PageHeader icon={ChessPawnIcon} title={widget?.scene.title ?? "Widget"} />
      <div className="mx-auto flex w-full max-w-[44rem] flex-col items-center gap-3 px-3 py-6">
        <WidgetCard widgetId={widgetId} channelId={widget?.channel_id ?? ""} userId={user?.id ?? null} />
        {widget && (
          <Link
            to={`/channels/${encodeURIComponent(widget.channel_id)}`}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Open the chat
          </Link>
        )}
      </div>
    </>
  );
}
