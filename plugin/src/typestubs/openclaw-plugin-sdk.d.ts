// Type stubs for the OpenClaw Plugin SDK surfaces this plugin uses.
// Real runtime types come from the host at load time. These stubs cover
// exactly the fields our code touches; they are intentionally narrow.

declare module "openclaw/plugin-sdk/channel-inbound" {
  import type {
    ChannelReplyDispatchContext,
    OpenClawConfig,
  } from "openclaw/plugin-sdk/core";

  export function dispatchInboundDirectDmWithRuntime(params: {
    cfg: OpenClawConfig;
    runtime: unknown;
    channel: string;
    channelLabel: string;
    accountId: string;
    peer: { kind: "direct" | "channel" | "group"; id: string };
    senderId: string;
    senderAddress: string;
    recipientAddress: string;
    conversationLabel: string;
    rawBody: string;
    messageId: string;
    timestamp?: number;
    commandAuthorized?: boolean;
    bodyForAgent?: string;
    commandBody?: string;
    provider?: string;
    surface?: string;
    originatingChannel?: string;
    originatingTo?: string;
    extraContext?: Record<string, unknown> | ChannelReplyDispatchContext;
    deliver: (payload: { text?: string; body?: string; [key: string]: unknown }) => Promise<void>;
    onRecordError: (err: unknown) => void;
    onDispatchError: (err: unknown, info: { kind: string }) => void;
  }): Promise<unknown>;
}

declare module "openclaw/plugin-sdk/core" {
  // Loose config shape. The real host type is richer; we only read channels.
  export interface OpenClawConfig {
    channels?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface ChannelMeta {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    docsLabel?: string;
    blurb: string;
    order?: number;
    systemImage?: string;
    detailLabel?: string;
    markdownCapable?: boolean;
    exposure?: { configured?: boolean; setup?: boolean; docs?: boolean };
    [key: string]: unknown;
  }

  export interface ChannelCapabilities {
    chatTypes: Array<"direct" | "group" | "channel" | "thread">;
    polls?: boolean;
    reactions?: boolean;
    edit?: boolean;
    unsend?: boolean;
    reply?: boolean;
    media?: boolean;
    nativeCommands?: boolean;
    threads?: boolean;
  }

  /** Free-form setup input bag. The host's real type covers many keys. */
  export type ChannelSetupInput = Record<string, unknown>;

  export interface ChannelConfigAdapter<ResolvedAccount> {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    defaultAccountId?: (cfg: OpenClawConfig) => string;
    isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
    unconfiguredReason?: (account: ResolvedAccount, cfg: OpenClawConfig) => string;
    describeAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => unknown;
  }

  export interface ChannelSetupAdapter {
    resolveAccountId?: (params: {
      cfg: OpenClawConfig;
      accountId?: string;
      input?: ChannelSetupInput;
    }) => string;
    applyAccountConfig: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      input: ChannelSetupInput;
    }) => OpenClawConfig;
    validateInput?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      input: ChannelSetupInput;
    }) => string | null;
    afterAccountConfigWritten?: (params: {
      previousCfg: OpenClawConfig;
      cfg: OpenClawConfig;
      accountId: string;
      input: ChannelSetupInput;
    }) => Promise<void> | void;
  }

  export interface ChannelSetupStatus {
    channel: string;
    configured: boolean;
    statusLines: string[];
    selectionHint?: string;
    quickstartScore?: number;
  }

  export interface ChannelSetupStatusContext {
    cfg: OpenClawConfig;
    accountOverrides?: Partial<Record<string, string>>;
    [key: string]: unknown;
  }

  export interface WizardProgress {
    update: (message: string) => void;
    stop: (message?: string) => void;
  }

  export interface WizardPrompter {
    text: (opts: {
      message: string;
      placeholder?: string;
      initialValue?: string;
      validate?: (value: string) => string | undefined;
    }) => Promise<string>;
    password?: (opts: { message: string; placeholder?: string }) => Promise<string>;
    confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
    note?: (message: string, title?: string) => Promise<void>;
    progress?: (label: string) => WizardProgress;
    log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  }

  export interface ChannelSetupConfigureContext {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    accountOverrides?: Partial<Record<string, string>>;
    shouldPromptAccountIds?: boolean;
    forceAllowFrom?: boolean;
    [key: string]: unknown;
  }

  export interface ChannelSetupResult {
    cfg: OpenClawConfig;
    accountId?: string;
  }

  export interface ChannelSetupWizardAdapter {
    channel: string;
    getStatus: (ctx: ChannelSetupStatusContext) => Promise<ChannelSetupStatus>;
    configure: (ctx: ChannelSetupConfigureContext) => Promise<ChannelSetupResult>;
    afterConfigWritten?: (ctx: {
      previousCfg: OpenClawConfig;
      cfg: OpenClawConfig;
      accountId: string;
    }) => Promise<void> | void;
    disable?: (cfg: OpenClawConfig) => OpenClawConfig;
  }

  export interface OutboundDeliveryResult {
    channel: string;
    messageId: string;
    chatId?: string;
    channelId?: string;
    timestamp?: number;
    meta?: Record<string, unknown>;
  }

  /** Host-provided local-file access for outbound media (subset of the
   *  host's `OutboundMediaAccess`; we only pass it through to the SDK's
   *  `loadOutboundMediaFromUrl`). */
  export interface OutboundMediaAccess {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  }

  export interface ChannelOutboundContext {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    threadId?: string | number | null;
    replyToId?: string | null;
    silent?: boolean;
    mediaUrl?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
  }

  export interface ChannelOutboundAdapter {
    deliveryMode: "direct" | "gateway" | "hybrid";
    textChunkLimit?: number;
    sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
    sendMedia?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  }

  /**
   * Plugin-side hooks the host's message tool uses to validate and resolve
   * outbound targets (channel UUIDs, the `default` sentinel, peer-prefixed
   * addresses from session deliveryContext). The real host type carries many
   * more fields; we declare only what the Clawbits plugin populates so the
   * stub keeps the surface narrow but type-safe.
   */
  export interface ChannelMessagingAdapter {
    targetPrefixes?: readonly string[];
    normalizeTarget?: (raw: string) => string | undefined;
    targetResolver?: {
      looksLikeId?: (raw: string, normalized?: string) => boolean;
      hint?: string;
      resolveTarget?: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        input: string;
        normalized: string;
        preferredKind?: string;
      }) => Promise<{
        to: string;
        kind: string;
        display?: string;
        source?: "normalized" | "directory";
      } | null>;
    };
  }

  /**
   * Minimal shape of an inbound reply dispatch context. The host's real type
   * (`FinalizedMsgContext`) carries more fields; we only declare what the
   * plugin populates so TypeScript can type-check the call site.
   */
  export interface ChannelReplyDispatchContext {
    Channel: string;
    Body: string;
    BodyForAgent?: string;
    RawBody?: string;
    CommandBody?: string;
    From: string;
    To: string;
    SessionKey: string;
    ParentSessionKey?: string;
    AccountId?: string;
    ChatType?: "direct" | "group" | "channel" | "thread" | string;
    ConversationId?: string;
    ParentConversationId?: string;
    ConversationLabel?: string;
    [key: string]: unknown;
  }

  /**
   * Reply helpers hung off `ctx.channelRuntime.reply`. These are supplied by
   * the host at runtime; the plugin invokes them to forward inbound messages
   * into OpenClaw's reply pipeline.
   */
  export interface ChannelReplyRuntime {
    /**
     * Normalize a loosely-typed inbound context object into a fully-populated
     * `FinalizedMsgContext` (templating defaults, missing fields, etc.). The
     * host returns the same shape as our local `ChannelReplyDispatchContext`
     * but enriched. Optional: if absent, the plugin forwards its own object.
     */
    finalizeInboundContext?: (ctx: Record<string, unknown>) => ChannelReplyDispatchContext;
    dispatchReplyWithBufferedBlockDispatcher?: (params: {
      ctx: ChannelReplyDispatchContext;
      cfg: OpenClawConfig;
      dispatcherOptions?: Record<string, unknown>;
      replyOptions?: Record<string, unknown>;
    }) => Promise<void>;
    dispatchReplyFromConfig?: (params: {
      ctx: ChannelReplyDispatchContext;
      cfg: OpenClawConfig;
      dispatcher?: unknown;
      replyOptions?: Record<string, unknown>;
    }) => Promise<void>;
    [key: string]: unknown;
  }

  /**
   * Shape of the minimum route object returned by
   * `channelRuntime.routing.resolveAgentRoute`. The host's real type has
   * more fields (matchedBy, lastRoutePolicy, etc.); we only type what we
   * read so unknown extras pass through unchecked.
   */
  export interface ResolvedAgentRoute {
    agentId: string;
    channel: string;
    accountId: string;
    sessionKey: string;
    mainSessionKey?: string;
    [key: string]: unknown;
  }

  /**
   * Routing helpers hung off `ctx.channelRuntime.routing`. External plugins
   * call `resolveAgentRoute` to turn an inbound (channel, account, peer)
   * tuple into the correct agentId + sessionKey before dispatching a reply.
   */
  export interface ChannelRoutingRuntime {
    resolveAgentRoute?: (input: {
      cfg: OpenClawConfig;
      channel: string;
      accountId?: string | null;
      peer?: { kind: string; id: string } | null;
      parentPeer?: { kind: string; id: string } | null;
      guildId?: string | null;
      teamId?: string | null;
      memberRoleIds?: string[];
    }) => ResolvedAgentRoute;
    [key: string]: unknown;
  }

  /**
   * The opaque runtime bag the host passes to channel gateway/start hooks.
   * In production this is `ChannelRuntimeSurface` from
   * `src/channels/plugins/channel-runtime-surface.types.ts`. We expose only
   * the `reply` and `routing` branches plus a passthrough index signature so
   * third-party plugins can reach additional helpers without broad type
   * surgery.
   */
  export interface ChannelRuntimeSurface {
    reply?: ChannelReplyRuntime;
    routing?: ChannelRoutingRuntime;
    runtimeContexts?: unknown;
    [key: string]: unknown;
  }

  /** Loose account snapshot for `getStatus`/`setStatus`. */
  export interface ChannelAccountSnapshot {
    accountId?: string;
    configured?: boolean;
    connected?: boolean;
    [key: string]: unknown;
  }

  export interface ChannelLogSink {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  }

  export interface ChannelGatewayContext<ResolvedAccount = unknown> {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime?: unknown;
    abortSignal: AbortSignal;
    log?: ChannelLogSink;
    getStatus?: () => ChannelAccountSnapshot;
    setStatus?: (snapshot: Partial<ChannelAccountSnapshot>) => void;
    channelRuntime?: ChannelRuntimeSurface;
  }

  /**
   * Adapter slot for inbound/gateway work. A polling or websocket loop lives
   * inside `startAccount`; `stopAccount` is optional because `abortSignal`
   * already drives shutdown.
   */
  export interface ChannelGatewayAdapter<ResolvedAccount = unknown> {
    startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
    stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
    resolveGatewayAuthBypassPaths?: (params: { cfg: OpenClawConfig }) => string[];
  }

  export interface ChannelPlugin<ResolvedAccount = unknown> {
    id: string;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
    config: ChannelConfigAdapter<ResolvedAccount>;
    configSchema?: unknown;
    setup?: ChannelSetupAdapter;
    setupWizard?: ChannelSetupWizardAdapter;
    outbound?: ChannelOutboundAdapter;
    gateway?: ChannelGatewayAdapter<ResolvedAccount>;
    [key: string]: unknown;
  }

  /**
   * Minimal commander.js `Command` shape we touch from the plugin CLI registrar.
   * The host hands us a real commander Command at runtime; we only declare the
   * methods we call so TypeScript stops complaining without pulling in commander.
   */
  export interface OpenClawPluginCliCommand {
    command(name: string): OpenClawPluginCliCommand;
    description(text: string): OpenClawPluginCliCommand;
    summary?(text: string): OpenClawPluginCliCommand;
    option(
      flags: string,
      description?: string,
      defaultValue?: unknown,
    ): OpenClawPluginCliCommand;
    requiredOption?(
      flags: string,
      description?: string,
      defaultValue?: unknown,
    ): OpenClawPluginCliCommand;
    action(
      handler: (...args: unknown[]) => void | Promise<void>,
    ): OpenClawPluginCliCommand;
  }

  export interface OpenClawPluginCliContext {
    program: OpenClawPluginCliCommand;
    config: OpenClawConfig;
    workspaceDir?: string;
    logger?: {
      info?: (msg: string) => void;
      warn?: (msg: string) => void;
      error?: (msg: string) => void;
      debug?: (msg: string) => void;
    };
  }

  export interface OpenClawPluginCliCommandDescriptor {
    name: string;
    description: string;
    hasSubcommands: boolean;
  }

  export interface OpenClawPluginApi {
    registrationMode?: "full" | "setup-only" | "setup-runtime" | "cli-metadata" | "discovery";
    registerTool?: (opts: unknown) => void;
    registerHook?: (event: string, handler: unknown) => void;
    registerChannel?: (opts: { plugin: ChannelPlugin<unknown> }) => void;
    registerCli?: (
      registrar: (ctx: OpenClawPluginCliContext) => void | Promise<void>,
      opts?: {
        commands?: string[];
        descriptors?: OpenClawPluginCliCommandDescriptor[];
      },
    ) => void;
    runtime?: unknown;
    [key: string]: unknown;
  }

  export interface DefinedChannelPluginEntry<TPlugin> {
    id: string;
    name: string;
    description: string;
    configSchema: unknown;
    register: (api: OpenClawPluginApi) => void;
    channelPlugin: TPlugin;
  }

  export function defineChannelPluginEntry<TPlugin>(opts: {
    id: string;
    name: string;
    description: string;
    plugin: TPlugin;
    configSchema?: unknown | (() => unknown);
    setRuntime?: (runtime: unknown) => void;
    registerCliMetadata?: (api: OpenClawPluginApi) => void;
    registerFull?: (api: OpenClawPluginApi) => void;
  }): DefinedChannelPluginEntry<TPlugin>;
}

declare module "openclaw/plugin-sdk/outbound-media" {
  import type { OutboundMediaAccess } from "openclaw/plugin-sdk/core";

  /** Subset of the host's OutboundMediaLoadOptions this plugin passes. */
  export interface OutboundMediaLoadOptions {
    maxBytes?: number;
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[] | "any";
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  }

  /** Host's WebMediaResult, narrowed to the fields we read. */
  export interface OutboundMediaLoadResult {
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
    kind?: string;
  }

  export function loadOutboundMediaFromUrl(
    mediaUrl: string,
    options?: OutboundMediaLoadOptions,
  ): Promise<OutboundMediaLoadResult>;
}

declare module "openclaw/plugin-sdk/skills-runtime" {
  /** Fires on every committed skill create/update/removal, including ones the
   *  agent made itself. Returns an unsubscribe. */
  export function registerSkillsChangeListener(
    listener: (event: { workspaceDir?: string; reason?: string; changedPath?: string }) => void,
  ): () => void;
  export function getSkillsSnapshotVersion(workspaceDir?: string): number;
  /** Force a snapshot refresh after our own write, instead of waiting on the
   *  file watcher. */
  export function bumpSkillsSnapshotVersion(params: {
    workspaceDir?: string;
    reason?: string;
    changedPath?: string;
  }): number;
}
