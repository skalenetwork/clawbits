// The three Clawbits chat game tools, exactly as the server declares them for every runtime
// (clawbits/widgets/tool_spec.json, an MCP `tools/list` result): name, description, inputSchema
// and annotations. A copy, since the server's file doesn't ship with the plugin; a test keeps the
// two equal, so a wording change is made on the server and copied here.

export interface WidgetToolSpec {
  name: "clawbits_widget_act" | "clawbits_widget_get" | "clawbits_widget_list";
  description: string;
  inputSchema: {
    type: "object";
    required?: string[];
    additionalProperties: false;
    properties: Record<string, Record<string, unknown>>;
  };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
}

const WIDGET_ID = {
  type: "string",
  description: "The Clawbits chat game's id. Omit for the active game in the current chat.",
};

export const WIDGET_ACT_SPEC: WidgetToolSpec = {
  name: "clawbits_widget_act",
  description:
    "Take your move in a Clawbits chat game: one action from the game view's legal list. " +
    "Returns a one-line result, and the fresh view while it is still your move. Never post " +
    "chat text about the game; finish with NO_REPLY.",
  inputSchema: {
    type: "object",
    required: ["type"],
    additionalProperties: false,
    properties: {
      widget_id: WIDGET_ID,
      type: {
        type: "string",
        minLength: 1,
        maxLength: 32,
        description: "The action's type, from legal: move, fire, call, raise, bet, ...",
      },
      args: {
        type: "object",
        description:
          'The action\'s args, from legal: e.g. {"move":"e4"} {"at":"B7"} {"to":120} ' +
          '(poker: the TOTAL your bet on this street comes to) {"amount":50}. ' +
          "At most 1024 characters as JSON.",
      },
      rev: {
        type: "integer",
        minimum: 0,
        description: "The rev you decided on; the move is refused if the game changed since.",
      },
    },
  },
  annotations: {
    title: "Act in a Clawbits chat game",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const WIDGET_GET_SPEC: WidgetToolSpec = {
  name: "clawbits_widget_get",
  description:
    "Read a Clawbits chat game you play: the board as text and whose move it is. Your legal " +
    "actions and how to take them come only in the game's own session.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { widget_id: WIDGET_ID },
  },
  annotations: {
    title: "Read a Clawbits chat game",
    readOnlyHint: true,
    openWorldHint: false,
  },
};

export const WIDGET_LIST_SPEC: WidgetToolSpec = {
  name: "clawbits_widget_list",
  description: "List the active Clawbits chat games you have a seat in.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      waiting: {
        type: "boolean",
        description: "Only the games waiting on your move.",
      },
    },
  },
  annotations: {
    title: "List your Clawbits chat games",
    readOnlyHint: true,
    openWorldHint: false,
  },
};

/** In the server file's order. */
export const WIDGET_TOOL_SPECS: readonly WidgetToolSpec[] = [
  WIDGET_ACT_SPEC,
  WIDGET_GET_SPEC,
  WIDGET_LIST_SPEC,
];
