import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ClawBitsClient } from "./client.js";
import type { InboundUiAction } from "./inbound-types.js";
import { currentConfig } from "./model-choice.js";
import { pluginRuntime, type KeyedStore } from "./runtime.js";
import * as mmTools from "./tools/mattermost.js";
import type { AgentSurfaceCreate } from "./types.js";

/** What an ask_user card's option buttons send: the plugin answers the question, no turn runs. */
export const QUESTION_EVENT = "oc.question";

/** The longest an ask_user question waits for its answer. */
const QUESTION_WAIT_MS = 60 * 60_000;

/** An ask_user prompt as a card, carried from `renderPresentation` to `sendPayload` in `channelData.clawbits`. */
export interface QuestionCard {
  questionId: string;
  surface: AgentSurfaceCreate;
  /** The question's plain text, posted instead when the server refuses the card. */
  fallback: string;
}

/** A click posts its button's label as the user's message, so the server refuses one that starts with
 *  `/` or carries an `@` or a link. */
function clickable(label: string): boolean {
  return !(label.trimStart().startsWith("/") || label.includes("@") || label.includes("://"));
}

/**
 * Core's ask_user presentation as a card: the title as a bold Text, text and context blocks as Texts
 * (context as a caption), each option as a Button sending `oc.question` with its `optionValue`, and a
 * custom answer as a hint to type it. The plugin closes the card itself, so it is `once: false`. Null
 * for any other block or action, or a label no click could post, and core renders the text instead.
 */
export function questionSurface(presentation: MessagePresentation): Omit<QuestionCard, "questionId"> | null {
  const components: Array<Record<string, unknown>> = [];
  const add = (component: Record<string, unknown>): string => {
    const id = `c${String(components.length)}`;
    components.push({ id, ...component });
    return id;
  };
  const text = (value: string, variant?: "caption"): string =>
    add({ component: "Text", text: value, ...(variant ? { variant } : {}) });
  const children: string[] = [];
  const lines: string[] = [];
  if (presentation.title) {
    lines.push(presentation.title);
    children.push(text(`**${presentation.title}**`));
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      lines.push(block.text);
      children.push(text(block.text, block.type === "context" ? "caption" : undefined));
      continue;
    }
    if (block.type !== "buttons") return null;
    const options: string[] = [];
    let custom = false;
    for (const { label, action } of block.buttons) {
      if (action?.type !== "question") return null;
      if ("intent" in action) {
        custom = true;
        continue;
      }
      if (!clickable(label)) return null;
      const event = { name: QUESTION_EVENT, context: { optionValue: action.optionValue } };
      options.push(add({ component: "Button", child: text(label), action: { event } }));
    }
    if (options.length) children.push(add({ component: "Row", children: options }));
    if (custom) children.push(text("Or type your own answer.", "caption"));
  }
  return {
    surface: { components: [{ id: "root", component: "Column", children }, ...components], once: false },
    fallback: lines.join("\n\n"),
  };
}

const waiting = new Map<string, { questionId: string; until: number }>();
const chatKey = (accountId: string, channelId: string): string => `${accountId}:${channelId}`;

/** The chat waits on this question: a typed post there answers it rather than starting a turn. */
export function markQuestionWaiting(accountId: string, channelId: string, questionId: string): void {
  waiting.set(chatKey(accountId, channelId), { questionId, until: Date.now() + QUESTION_WAIT_MS });
}

export function questionWaiting(accountId: string, channelId: string): boolean {
  return (waiting.get(chatKey(accountId, channelId))?.until ?? 0) > Date.now();
}

/** The question was answered, expired or cancelled; a newer question in the chat keeps it waiting. */
export function questionEnded(accountId: string, channelId: string, questionId: string): void {
  const key = chatKey(accountId, channelId);
  if (waiting.get(key)?.questionId === questionId) waiting.delete(key);
}

/** Which question a card asks, and in which chat: only a bound card's clicks answer anything. */
export interface QuestionBinding {
  channelId: string;
  questionId: string;
}

let bindingStore: KeyedStore<QuestionBinding> | undefined;
const bindings = (): KeyedStore<QuestionBinding> | undefined =>
  (bindingStore ??= pluginRuntime()?.state.openKeyedStore<QuestionBinding>({
    namespace: "ui-questions",
    maxEntries: 1_000,
    defaultTtlMs: QUESTION_WAIT_MS,
  }));
const bindingKey = (accountId: string, postId: number | string): string => `${accountId}:${String(postId)}`;

export async function bindQuestion(accountId: string, postId: string, binding: QuestionBinding): Promise<void> {
  await bindings()?.register(bindingKey(accountId, postId), binding);
}

export async function unbindQuestion(accountId: string, postId: string): Promise<void> {
  await bindings()?.delete(bindingKey(accountId, postId));
}

const finalizing = new Set<string>();

/** Core closes this card with its own status line once its question ends; until then a click that
 *  finds the question over leaves the close to that. */
export function questionFinalizing(accountId: string, postId: string, pending: boolean): void {
  const key = bindingKey(accountId, postId);
  if (pending) finalizing.add(key);
  else finalizing.delete(key);
}

/**
 * A click on a question card answers the card's question with the clicked option, and the chat stops
 * waiting at once. A card with no question behind it any more (a restart ends them all) closes, unless
 * core is about to close it with its own status line.
 */
export async function answerQuestionClick(
  client: ClawBitsClient,
  accountId: string,
  { surfacePostId, context }: InboundUiAction,
  senderId: string,
): Promise<void> {
  const binding = await bindings()?.lookup(bindingKey(accountId, surfacePostId));
  const { optionValue } = context;
  if (binding && typeof optionValue === "string") {
    const cfg = currentConfig();
    if (!cfg) throw new Error("The Clawbits channel has no config to answer a question with.");
    const { status } = await questionGatewayRuntime.resolveOption({ cfg, questionId: binding.questionId, optionValue, senderId });
    questionEnded(accountId, binding.channelId, binding.questionId);
    if (status === "answered") return;
  }
  if (!finalizing.has(bindingKey(accountId, surfacePostId))) {
    await mmTools.closeSurface(client, surfacePostId, "No longer open");
  }
}

/** Test seam: forget waiting chats, pending closes and the binding store between cases. */
export function __resetQuestionsForTest(): void {
  waiting.clear();
  finalizing.clear();
  bindingStore = undefined;
}
