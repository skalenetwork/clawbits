import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageMarkdown } from "@/components/MessageMarkdown";
import { postUiAction, type PostUi, type UiActionRequest } from "@/lib/api";
import {
  actionRequest,
  buildTree,
  checkFailures,
  pathOf,
  resolveText,
  write,
  type Model,
  type UiNode,
  type UiNodeOf,
} from "@/lib/a2ui/core";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Chart } from "./Chart";
import { CheckBox, ChoicePicker, DateTimeInput, SurfaceButton, TextField } from "./controls";
import { KeyValue, Notice, Stats, StatusList, Table, Text } from "./display";

type Stack = UiNodeOf<"Column" | "Row">;

interface SurfaceProps {
  ui: PostUi;
  message: string;
  postId: number;
  channelId: string;
}

const JUSTIFY = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between",
  spaceAround: "justify-around",
  spaceEvenly: "justify-evenly",
  stretch: "*:flex-1",
} satisfies Record<Stack["justify"], string>;

const ALIGN = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
} satisfies Record<Stack["align"], string>;

function textFields(node: UiNode): UiNodeOf<"TextField">[] {
  switch (node.component) {
    case "Column":
    case "Row":
      return node.children.flatMap(textFields);
    case "Card":
      return textFields(node.child);
    case "TextField":
      return [node];
    default:
      return [];
  }
}

/** An agent's A2UI surface in its post, or the post's text when this kit cannot draw the tree. Each rev starts over
 *  from the surface's own data model. */
export default function Surface({ ui, message, postId, channelId }: SurfaceProps) {
  const root = buildTree(ui.a2ui.createSurface);
  if (!root) return <MessageMarkdown content={message} />;
  return <SurfaceRev key={ui.rev} root={root} ui={ui} postId={postId} channelId={channelId} />;
}

/** One rev of a surface: the local data model its inputs write to, and one action out at a time. A `once` surface
 *  stays locked after its accepted action until its close arrives; a closed one keeps every control disabled and
 *  says how it closed. A Button runs its own checks and those of each TextField its context binds, as the server
 *  does; while one fails, a press sends nothing, and the last pressed Button's first failing text shows below the
 *  card. Trying the same click again after an error keeps its key, so a click the server took before the error comes
 *  back as its post instead of a second one. Escape inside an unlocked card stays there instead of leaving the chat
 *  and the card's values. */
function SurfaceRev({ root, ui, postId, channelId }: Omit<SurfaceProps, "message"> & { root: UiNode }) {
  const qc = useQueryClient();
  const [model, setModel] = useState<Model>(ui.a2ui.createSurface.dataModel);
  const [pressed, setPressed] = useState<UiNodeOf<"Button"> | null>(null);
  const unsettled = useRef<UiActionRequest | null>(null);
  const send = useMutation({
    mutationFn: (request: UiActionRequest) => postUiAction(postId, request),
    onMutate: (request) => { unsettled.current = request; },
    onSuccess: (post) => {
      unsettled.current = null;
      if (!post) void qc.invalidateQueries({ queryKey: queryKeys.mm.channelPosts(channelId, 50, 0) });
    },
  });
  const closed = ui.closed != null;
  const locked = closed || send.isPending || (ui.once && send.data != null);
  const pending = send.isPending ? send.variables.sourceComponentId : null;
  const fields = textFields(root);

  const failures = (button: UiNodeOf<"Button">) => {
    const context = button.action.kind === "event" ? Object.values(button.action.context) : [];
    const bound = new Set(context.flatMap((value) => pathOf(value) ?? []));
    const checks = fields.flatMap((field) => {
      const path = pathOf(field.value);
      return path !== undefined && bound.has(path) ? field.checks : [];
    });
    return checkFailures([...button.checks, ...checks], model);
  };
  const refusal = pressed && failures(pressed)[0];

  const writer = (value: unknown) => {
    const path = pathOf(value);
    return path === undefined ? undefined : (next: unknown) => { setModel((m) => write(m, path, next)); };
  };

  const act = (button: UiNodeOf<"Button">) => {
    if (locked) return;
    setPressed(button);
    if (failures(button).length > 0) return;
    const request = actionRequest(button, model, ui.rev, crypto.randomUUID());
    if (!request) return;
    const last = unsettled.current;
    const again = last?.sourceComponentId === request.sourceComponentId && JSON.stringify(last.bound) === JSON.stringify(request.bound);
    send.mutate(again ? { ...request, client_key: last.client_key } : request);
  };

  const render = (node: UiNode): ReactNode => {
    switch (node.component) {
      case "Column":
      case "Row":
        return (
          <div
            key={node.id}
            className={cn(
              "flex min-w-0 gap-2",
              node.component === "Column" ? "flex-col" : "flex-wrap",
              JUSTIFY[node.justify],
              ALIGN[node.align],
            )}
          >
            {node.children.map(render)}
          </div>
        );
      case "Card":
        return <div key={node.id} className="min-w-0 rounded-[14px] bg-card p-3">{render(node.child)}</div>;
      case "Divider":
        return <hr key={node.id} className="w-full border-foreground/8" />;
      case "Text":
        return <Text key={node.id} node={node} model={model} />;
      case "Button":
        return (
          <SurfaceButton
            key={node.id}
            node={node}
            disabled={node.action.kind === "event" ? locked : closed}
            blocked={failures(node).length > 0}
            pending={pending === node.id}
            onAction={() => { act(node); }}
          >
            {resolveText(node.child.text, model)}
          </SurfaceButton>
        );
      case "TextField":
        return (
          <TextField
            key={node.id}
            node={node}
            model={model}
            disabled={locked}
            pressed={pressed !== null}
            onChange={writer(node.value)}
          />
        );
      case "ChoicePicker":
        return <ChoicePicker key={node.id} node={node} model={model} onChange={locked ? undefined : writer(node.value)} />;
      case "CheckBox":
        return <CheckBox key={node.id} node={node} model={model} disabled={locked} onChange={writer(node.value)} />;
      case "DateTimeInput":
        return <DateTimeInput key={node.id} node={node} model={model} disabled={locked} onChange={writer(node.value)} />;
      case "Notice":
        return <Notice key={node.id} node={node} />;
      case "KeyValue":
        return <KeyValue key={node.id} node={node} />;
      case "Stats":
        return <Stats key={node.id} node={node} />;
      case "StatusList":
        return <StatusList key={node.id} node={node} />;
      case "Table":
        return <Table key={node.id} node={node} />;
      case "Chart":
        return <Chart key={node.id} node={node} />;
    }
  };

  return (
    <div
      className="my-1 flex w-full min-w-0 flex-col gap-1.5"
      onKeyDown={(e) => { if (e.key === "Escape" && !locked) e.preventDefault(); }}
    >
      {render(root)}
      {ui.closed && <p className="text-[13px] text-muted-foreground">{ui.closed.text}</p>}
      {refusal && <p role="status" className="text-[13px] text-destructive">{refusal}</p>}
      {send.isError && (
        <p role="status" className="text-[13px] text-destructive">{errMsg(send.error, "That didn't go through")}</p>
      )}
      {send.data === null && <p role="status" className="text-[13px] text-muted-foreground">This card has changed.</p>}
    </div>
  );
}
