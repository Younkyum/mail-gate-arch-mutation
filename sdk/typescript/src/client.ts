import { HttpClient, type FetchLike } from './http.js';
import { connectRealtime, type RealtimeConnectOptions, type RealtimeConnection, type WebSocketConstructor } from './realtime.js';
import {
  Agents,
  Approvals,
  Attachments,
  Audit,
  Capabilities,
  Discovery,
  Drafts,
  Identity,
  Labels,
  Messages,
  Policy,
  Threads,
  Webhooks,
  type ResourceContext,
} from './resources.js';

export const SDK_VERSION = '0.1.1';
export const DEFAULT_ORIGIN = 'https://api.atmark.ai';

export interface AtmarkOptions {
  /** Agent token (`atk_agent_…`) created by the owner in the console. Optional only for public calls (identity, discovery). */
  readonly token?: string;
  /** API origin. Default `https://api.atmark.ai` (a trailing `/v1` is accepted and stripped). */
  readonly baseUrl?: string;
  /** Optional default `agent_id`. Leave it out: an agent token is bound to one agent and the server uses that agent. */
  readonly agentId?: string;
  readonly fetch?: FetchLike;
  /** Per-attempt timeout. Default 30 s. */
  readonly timeoutMs?: number;
  /** Retries for safe requests (idempotent methods or ones with an Idempotency-Key). Default 2. */
  readonly maxRetries?: number;
  /** WebSocket constructor for realtime (default: the global one — Node 22 / browsers). On Node 20 pass `ws`. */
  readonly WebSocket?: WebSocketConstructor;
  /** Allow `http://localhost` / `127.0.0.1` as `baseUrl` (local tests only). */
  readonly allowInsecure?: boolean;
  /**
   * Extra hosts the realtime client may send the token to when the URL comes from the API. Built in:
   * `realtime.atmark.ai` and `*.execute-api.ap-northeast-2.amazonaws.com`. A `url` passed to `connect()` is trusted as is.
   */
  readonly realtimeHosts?: readonly string[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `https://` only; `http://` is accepted for loopback hosts with `allowInsecure: true` (local tests). */
export function normalizeOrigin(baseUrl: string, allowInsecure: boolean = false): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not a URL: ${baseUrl}`);
  }
  const insecureOk = url.protocol === 'http:' && allowInsecure && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !insecureOk) {
    throw new TypeError('baseUrl must be https:// (http://localhost or 127.0.0.1 only with allowInsecure: true)');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new TypeError('baseUrl must not carry credentials, a query or a fragment');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export class RealtimeClient {
  constructor(
    private readonly token: string | null,
    private readonly WebSocketImpl: WebSocketConstructor | undefined,
    private readonly discovery: Discovery,
    private readonly agents: Agents,
    private readonly agentId: string | null,
    private readonly extraHosts: readonly string[] = [],
  ) {}

  /** The WebSocket URL: the agent's connection info when an agentId is known, else the discovery document. */
  async resolveUrl(): Promise<string> {
    if (this.agentId !== null) {
      try {
        const info = await this.agents.realtime(this.agentId);
        if (typeof info.url === 'string' && info.url !== '') return info.url;
      } catch {
        // fall back to the public discovery document
      }
    }
    const document = await this.discovery.get();
    const realtime = document['realtime'] as { url?: unknown } | undefined;
    if (typeof realtime?.url !== 'string' || realtime.url === '') throw new Error('discovery document has no realtime.url');
    return realtime.url;
  }

  /** Open a realtime connection that keeps itself alive and reconnects until `close()` or `signal` aborts. */
  connect(options: RealtimeConnectOptions): RealtimeConnection {
    return connectRealtime(
      {
        token: this.token,
        WebSocket: this.WebSocketImpl,
        resolveUrl: () => this.resolveUrl(),
        realtimeHosts: this.extraHosts,
        random: Math.random,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      },
      options,
    );
  }
}

export class Atmark {
  readonly messages: Messages;
  readonly threads: Threads;
  readonly drafts: Drafts;
  readonly labels: Labels;
  readonly attachments: Attachments;
  readonly approvals: Approvals;
  readonly policy: Policy;
  readonly capabilities: Capabilities;
  readonly agents: Agents;
  readonly identity: Identity;
  readonly webhooks: Webhooks;
  readonly audit: Audit;
  readonly discovery: Discovery;
  readonly realtime: RealtimeClient;

  constructor(options: AtmarkOptions = {}) {
    const fetchImpl: FetchLike | undefined = options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (fetchImpl === undefined) throw new Error('No fetch implementation: use Node 20+ or pass { fetch }.');
    const http = new HttpClient({
      token: options.token ?? null,
      origin: normalizeOrigin(options.baseUrl ?? DEFAULT_ORIGIN, options.allowInsecure === true),
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      userAgent: `atmark-sdk-typescript/${SDK_VERSION}`,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
    });
    if (options.agentId === '') throw new TypeError('agentId must not be empty — omit it to use the agent of your token');
    const context: ResourceContext = { http, agentId: options.agentId ?? null };
    this.messages = new Messages(context);
    this.threads = new Threads(context);
    this.drafts = new Drafts(context);
    this.labels = new Labels(context);
    this.attachments = new Attachments(context, fetchImpl);
    this.approvals = new Approvals(context);
    this.policy = new Policy(context);
    this.capabilities = new Capabilities(context);
    this.agents = new Agents(context);
    this.identity = new Identity(context);
    this.webhooks = new Webhooks(context);
    this.audit = new Audit(context);
    this.discovery = new Discovery(context);
    const globalWebSocket = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    this.realtime = new RealtimeClient(options.token ?? null, options.WebSocket ?? globalWebSocket, this.discovery, this.agents, options.agentId ?? null, options.realtimeHosts ?? []);
  }
}
