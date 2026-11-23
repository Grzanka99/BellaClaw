import { createHash, randomBytes } from "node:crypto";
import { createSystemTurnId } from "@bellaclaw/behavior-logs";
import { EEventType } from "@bellaclaw/database";
import { AsyncQueue, logger, type TOption } from "@bellaclaw/shared";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { commandFailed, ESubscriptionMode, EventBus } from "../../../events";
import { IdentityService } from "../../../identity";
import { EIdentityLinkOwner } from "../../../identity/schema";
import { getConnector, type TConnector } from "../../config";
import { McpAuthCredentialStore } from "./store";

const CALLBACK_PATH = "/mcp/oauth/callback";
const STATE_TTL_MS = 10 * 60 * 1000;
const RESERVED_AUTHORIZATION_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "nonce",
  "redirect_uri",
  "request",
  "request_uri",
  "resource",
  "response_mode",
  "response_type",
  "scope",
  "state",
]);
const credentialStore = new McpAuthCredentialStore();
const pendingStates = new Map<string, TPendingState>();
const runtimeProviders = new Map<string, { generation: number; provider: OAuthClientProvider }>();
const refreshRequests = new Map<string, Promise<TCachedResponse>>();
const authQueues = new Map<string, AsyncQueue>();
const authGenerations = new Map<string, number>();
let authServer: TOption<ReturnType<typeof Bun.serve>>;

type TPendingState = {
  chatId: string;
  connectorId: string;
  key: string;
  generation: number;
  expiresAt: number;
};

type TAuthorizationRedirect = (url: URL, state: string) => void | Promise<void>;

type TCachedResponse = {
  body: Blob;
  headers: Headers;
  status: number;
  statusText: string;
};

class McpOAuthClientProvider implements OAuthClientProvider {
  private readonly key: string;
  private readonly authorizationState = randomBytes(32).toString("base64url");

  public constructor(
    private readonly chatId: string,
    private readonly connector: TConnector,
    private readonly store: McpAuthCredentialStore,
    private readonly onAuthorization: TOption<TAuthorizationRedirect>,
    private readonly generation: number,
    private readonly writesAlreadyQueued: boolean,
  ) {
    this.key = credentialKey(chatId, connector);
  }

  public get redirectUrl(): string {
    return callbackUrl();
  }

  public get clientMetadata(): OAuthClientMetadata {
    let scope: TOption<string>;
    if (this.connector.transport.type === "http" && this.connector.transport.oauth !== undefined) {
      scope = this.connector.transport.oauth.scopes.join(" ");
    }

    return {
      redirect_uris: [this.redirectUrl],
      client_name: "BellaClaw",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    };
  }

  public state(): string {
    return this.authorizationState;
  }

  public async clientInformation(): Promise<TOption<OAuthClientInformationMixed>> {
    this.assertCurrentGeneration();
    if (this.connector.transport.type !== "http" || this.connector.transport.oauth === undefined) {
      return undefined;
    }

    const clientIdEnv = this.connector.transport.oauth.clientIdEnv;
    if (clientIdEnv === undefined) {
      const clientInformation = await this.store.clientInformation(this.key);
      this.assertCurrentGeneration();
      return clientInformation;
    }

    const clientId = Bun.env[clientIdEnv]?.trim();
    if (clientId === undefined || clientId.length === 0) {
      throw new Error(`MCP OAuth client ID environment variable ${clientIdEnv} is not set`);
    }

    const clientInformation: OAuthClientInformationMixed = { client_id: clientId };
    const clientSecretEnv = this.connector.transport.oauth.clientSecretEnv;
    if (clientSecretEnv !== undefined) {
      const clientSecret = Bun.env[clientSecretEnv]?.trim();
      if (clientSecret === undefined || clientSecret.length === 0) {
        throw new Error(
          `MCP OAuth client secret environment variable ${clientSecretEnv} is not set`,
        );
      }
      clientInformation.client_secret = clientSecret;
    }
    return clientInformation;
  }

  public saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    return this.writeCredential(() =>
      this.store.saveClientInformation(this.key, clientInformation),
    );
  }

  public async tokens(): Promise<TOption<OAuthTokens>> {
    this.assertCurrentGeneration();
    const tokens = await this.store.tokens(this.key);
    this.assertCurrentGeneration();
    return tokens;
  }

  public saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.writeCredential(() => this.store.saveTokens(this.key, tokens));
  }

  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.onAuthorization === undefined) {
      throw new Error(
        `Connector ${this.connector.id} needs authentication. Run !connector-auth connect ${this.connector.id}`,
      );
    }
    this.assertCurrentGeneration();
    if (this.connector.transport.type !== "http" || this.connector.transport.oauth === undefined) {
      throw new Error(`Connector ${this.connector.id} does not use OAuth`);
    }
    for (const [name, value] of Object.entries(
      this.connector.transport.oauth.authorizationParams,
    )) {
      if (RESERVED_AUTHORIZATION_PARAMS.has(name) || authorizationUrl.searchParams.has(name)) {
        throw new Error(`MCP OAuth authorization parameter ${name} is reserved`);
      }
      authorizationUrl.searchParams.append(name, value);
    }

    pendingStates.set(this.authorizationState, {
      chatId: this.chatId,
      connectorId: this.connector.id,
      key: this.key,
      generation: this.generation,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    await this.onAuthorization(authorizationUrl, this.authorizationState);
  }

  public saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.writeCredential(() => this.store.saveCodeVerifier(this.key, codeVerifier));
  }

  public async codeVerifier(): Promise<string> {
    this.assertCurrentGeneration();
    const codeVerifier = await this.store.codeVerifier(this.key);
    this.assertCurrentGeneration();
    if (codeVerifier === undefined) {
      throw new Error("MCP OAuth callback has no saved PKCE verifier");
    }
    return codeVerifier;
  }

  public invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    return this.writeCredential(() => this.store.clear(this.key, scope));
  }

  private writeCredential(write: () => Promise<void>): Promise<void> {
    if (this.writesAlreadyQueued) {
      this.assertCurrentGeneration();
      return write();
    }

    return authQueue(this.key).enqueue(() => {
      this.assertCurrentGeneration();
      return write();
    });
  }

  private assertCurrentGeneration(): void {
    if (currentAuthGeneration(this.key) !== this.generation) {
      throw new Error(`MCP authentication for connector ${this.connector.id} was cancelled`);
    }
  }
}

export async function getMcpAuthProvider(
  chatId: string,
  connector: TConnector,
): Promise<TOption<OAuthClientProvider>> {
  if (connector.transport.type !== "http" || connector.transport.oauth === undefined) {
    return undefined;
  }
  const key = credentialKey(chatId, connector);
  // a stored connector uses OAuth once a connect registered a client; otherwise a token or nothing
  if (
    choosesCredentials(connector) &&
    (await credentialStore.clientInformation(key)) === undefined
  ) {
    return undefined;
  }
  const generation = currentAuthGeneration(key);
  const existing = runtimeProviders.get(key);
  if (existing !== undefined && existing.generation === generation) {
    return existing.provider;
  }

  const provider = new McpOAuthClientProvider(
    chatId,
    connector,
    credentialStore,
    undefined,
    generation,
    false,
  );
  runtimeProviders.set(key, { generation, provider });
  return provider;
}

export async function beginMcpAuth(chatId: string, connectorId: string): Promise<string> {
  const connector = await getConnector(chatId, connectorId);
  if (connector.transport.type !== "http" || connector.transport.oauth === undefined) {
    throw new Error(`Connector ${connectorId} does not use OAuth`);
  }

  const key = credentialKey(chatId, connector);
  const generation = advanceAuthGeneration(key);
  runtimeProviders.delete(key);
  const serverUrl = connector.transport.url;
  const authorizationUrl = await authQueue(key).enqueue(async () => {
    if (currentAuthGeneration(key) !== generation) {
      throw new Error(`MCP authentication for connector ${connectorId} was cancelled`);
    }
    for (const [state, pending] of pendingStates) {
      if (pending.key === key) {
        pendingStates.delete(state);
      }
    }
    await credentialStore.clear(key, "verifier");

    let redirectUrl: TOption<string>;
    const provider = new McpOAuthClientProvider(
      chatId,
      connector,
      credentialStore,
      (url) => {
        redirectUrl = url.toString();
      },
      generation,
      true,
    );
    await auth(provider, { serverUrl });
    return redirectUrl;
  });
  if (authorizationUrl === undefined) {
    throw new Error(`Connector ${connectorId} is already connected`);
  }
  return authorizationUrl;
}

export async function getMcpAuthStatus(chatId: string, connectorId: string): Promise<boolean> {
  const connector = await getConnector(chatId, connectorId);
  if (!usesChatCredentials(connector)) {
    throw new Error(`Connector ${connectorId} does not use OAuth or tokenAuth`);
  }
  return credentialStore.hasTokens(credentialKey(chatId, connector));
}

export async function disconnectMcpAuth(chatId: string, connectorId: string): Promise<boolean> {
  const connector = await getConnector(chatId, connectorId);
  if (!usesChatCredentials(connector)) {
    throw new Error(`Connector ${connectorId} does not use OAuth or tokenAuth`);
  }

  const key = credentialKey(chatId, connector);
  advanceAuthGeneration(key);
  runtimeProviders.delete(key);
  for (const [state, pending] of pendingStates) {
    if (pending.key === key) {
      pendingStates.delete(state);
    }
  }

  return authQueue(key).enqueue(() => credentialStore.delete(key));
}

export async function saveMcpAuthToken(
  chatId: string,
  connectorId: string,
  token: string,
): Promise<void> {
  const connector = await getConnector(chatId, connectorId);
  if (connector.transport.type !== "http" || !connector.transport.tokenAuth) {
    throw new Error(`Connector ${connectorId} does not use tokenAuth`);
  }

  // the token replaces every credential, so a stored connector that had OAuth uses the token
  const key = credentialKey(chatId, connector);
  await authQueue(key).enqueue(async () => {
    await credentialStore.delete(key);
    await credentialStore.saveTokens(key, { access_token: token, token_type: "bearer" });
  });
}

export async function getMcpAuthToken(
  chatId: string,
  connector: TConnector,
): Promise<TOption<string>> {
  if (connector.transport.type !== "http" || !connector.transport.tokenAuth) {
    return undefined;
  }

  const key = credentialKey(chatId, connector);
  const tokens = await credentialStore.tokens(key);
  if (choosesCredentials(connector)) {
    // OAuth tokens go through the provider; no credentials leave the server's 401 to report
    if ((await credentialStore.clientInformation(key)) !== undefined) {
      return undefined;
    }
    return tokens?.access_token;
  }
  if (tokens === undefined) {
    throw new Error(
      `Connector ${connector.id} needs a token. Run !connector-auth token ${connector.id} TOKEN`,
    );
  }
  return tokens.access_token;
}

// NOTE: each change also emits mcp.auth.credentials.changed, so live sessions stop using the old
// credentials
export function setupMcpAuth(): void {
  const bus = EventBus.instance;

  bus.subscribe({
    consumer: "mcp-auth",
    type: EEventType.McpAuthConnectRequested,
    mode: ESubscriptionMode.Durable,
    backoffMs: [],
    handler: async (event, ctx) => {
      const { chatId, profileId } = event.payload;

      let url: string;

      // a failed start has already invalidated the runtime provider
      try {
        url = await beginMcpAuth(chatId, profileId);
      } catch (error) {
        await ctx.complete(async (_tx, emit) => {
          emit(EEventType.McpAuthCredentialsChanged, { chatId, profileId }, undefined, undefined);
          emit(EEventType.CommandRejected, commandFailed(event.type, error), undefined, undefined);
        });
        return;
      }

      await ctx.complete(async (_tx, emit) => {
        emit(EEventType.McpAuthCredentialsChanged, { chatId, profileId }, undefined, undefined);
        emit(EEventType.McpAuthLinkCreated, { chatId, profileId, url }, undefined, undefined);
      });
    },
  });
  bus.subscribe({
    consumer: "mcp-auth",
    type: EEventType.McpAuthDisconnectRequested,
    mode: ESubscriptionMode.Durable,
    backoffMs: [],
    handler: async (event, ctx) => {
      const { chatId, profileId } = event.payload;

      let disconnected: boolean;

      try {
        disconnected = await disconnectMcpAuth(chatId, profileId);
      } catch (error) {
        await ctx.complete(async (_tx, emit) => {
          emit(EEventType.CommandRejected, commandFailed(event.type, error), undefined, undefined);
        });
        return;
      }

      await ctx.complete(async (_tx, emit) => {
        emit(EEventType.McpAuthCredentialsChanged, { chatId, profileId }, undefined, undefined);
        emit(
          EEventType.McpAuthDisconnected,
          { chatId, profileId, disconnected },
          undefined,
          undefined,
        );
      });
    },
  });
  bus.subscribe({
    consumer: "mcp-auth",
    type: EEventType.McpAuthTokenSaveRequested,
    mode: ESubscriptionMode.Durable,
    backoffMs: [],
    handler: async (event, ctx) => {
      const { chatId, profileId, token } = event.payload;

      try {
        await saveMcpAuthToken(chatId, profileId, token);
      } catch (error) {
        await ctx.complete(async (_tx, emit) => {
          emit(EEventType.CommandRejected, commandFailed(event.type, error), undefined, undefined);
        });
        return;
      }

      await ctx.complete(async (_tx, emit) => {
        // live sessions still send the previous token
        emit(EEventType.McpAuthCredentialsChanged, { chatId, profileId }, undefined, undefined);
        emit(EEventType.McpAuthTokenSaved, { chatId, profileId }, undefined, undefined);
      });
    },
  });
  // a deleted stored connector takes the owner's credentials for it along
  bus.subscribe({
    consumer: "mcp-auth",
    type: EEventType.ConnectorsChanged,
    mode: ESubscriptionMode.Durable,
    backoffMs: [1_000, 5_000],
    handler: async (event) => {
      const { ownerKey, connectorId, connector } = event.payload;

      if (connector !== null) {
        return;
      }

      const deleted = await credentialStore.deleteAll(
        `${encodeURIComponent(ownerKey)}:${connectorId}:`,
      );

      for (const key of deleted) {
        advanceAuthGeneration(key);
        runtimeProviders.delete(key);
      }
    },
  });
  // NOTE: the account keeps its credentials when it has any; otherwise the address's move to it.
  // The file is written before the ack, and a second run finds nothing left to move
  bus.subscribe({
    consumer: "mcp-auth",
    type: EEventType.IdentityLinkQuiet,
    mode: ESubscriptionMode.Durable,
    backoffMs: [1_000, 5_000],
    handler: async (event, ctx) => {
      const { chatKey, ownerKey } = event.payload;
      const from = `${encodeURIComponent(chatKey)}:`;
      const moved = await credentialStore.moveAll(from, `${encodeURIComponent(ownerKey)}:`);
      const connectorIds = new Set<string>();

      for (const key of moved) {
        runtimeProviders.delete(key);
        const rest = key.slice(from.length);
        connectorIds.add(rest.slice(0, rest.lastIndexOf(":")));
      }

      await ctx.complete(async (_tx, emit) => {
        for (const connectorId of connectorIds) {
          for (const chatId of [chatKey, ownerKey]) {
            emit(
              EEventType.McpAuthCredentialsChanged,
              { chatId, profileId: connectorId },
              `${chatId}:${connectorId}`,
              undefined,
            );
          }
        }

        emit(
          EEventType.IdentityLinkMoved,
          { ...event.payload, owner: EIdentityLinkOwner.McpAuth },
          undefined,
          undefined,
        );
      });
    },
  });
}

export function createMcpAuthFetch(chatId: string, connectorId: string): FetchLike {
  const key = `${encodeURIComponent(chatId)}:${connectorId}`;
  return async (url, init) => {
    let refreshToken: TOption<string>;
    if (init?.body instanceof URLSearchParams && init.body.get("grant_type") === "refresh_token") {
      refreshToken = init.body.get("refresh_token") ?? undefined;
    }

    if (refreshToken === undefined) {
      return new McpFetchResponse(await fetch(url, init));
    }

    const refreshKey = `${key}:${refreshToken}`;
    let request = refreshRequests.get(refreshKey);
    if (request === undefined) {
      request = fetch(url, init).then(async (response) => ({
        body: await response.blob(),
        headers: new Headers(response.headers),
        status: response.status,
        statusText: response.statusText,
      }));
      refreshRequests.set(refreshKey, request);
      const clear = () => {
        setTimeout(() => refreshRequests.delete(refreshKey), 1_000);
      };
      void request.then(clear, clear);
    }
    return new McpFetchResponse(await request);
  };
}

export async function handleMcpAuthCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== CALLBACK_PATH) {
    return new Response("Not found", { status: 404 });
  }

  const state = url.searchParams.get("state");
  if (state === null) {
    return callbackResponse("Missing OAuth state.", 400);
  }

  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (
    pending === undefined ||
    pending.expiresAt < Date.now() ||
    currentAuthGeneration(pending.key) !== pending.generation
  ) {
    return callbackResponse("This authorization link is invalid or expired.", 400);
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError !== null) {
    return callbackResponse(`Authorization was declined: ${oauthError}`, 400);
  }

  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) {
    return callbackResponse("Missing authorization code.", 400);
  }

  try {
    await authQueue(pending.key).enqueue(async () => {
      if (currentAuthGeneration(pending.key) !== pending.generation) {
        throw new Error("MCP OAuth callback was cancelled");
      }
      const connector = await getConnector(pending.chatId, pending.connectorId);
      if (connector.transport.type !== "http" || connector.transport.oauth === undefined) {
        throw new Error(`Connector ${pending.connectorId} does not use OAuth`);
      }
      if (credentialKey(pending.chatId, connector) !== pending.key) {
        throw new Error("MCP OAuth configuration changed during authorization");
      }
      const provider = new McpOAuthClientProvider(
        pending.chatId,
        connector,
        credentialStore,
        undefined,
        pending.generation,
        true,
      );
      await auth(provider, { serverUrl: connector.transport.url, authorizationCode: code });
      if (currentAuthGeneration(pending.key) !== pending.generation) {
        throw new Error("MCP OAuth callback was cancelled");
      }
    });
    try {
      // the trace names the conversation the owner key belongs to
      const conversationKey = await IdentityService.instance.conversationKeyOf(pending.chatId);
      await EventBus.instance.publish({
        type: EEventType.McpAuthConnected,
        source: "mcp-auth",
        key: pending.chatId,
        trace: { turnId: createSystemTurnId(), chatId: conversationKey, platform: undefined },
        payload: { chatId: pending.chatId, profileId: pending.connectorId },
        causationId: undefined,
        dedupeKey: undefined,
      });
    } catch (_error) {
      logger.warning("MCP OAuth connection notice could not be published");
    }
    return callbackResponse(
      `Connected connector ${pending.connectorId}. You can close this window.`,
      200,
    );
  } catch (_error) {
    return callbackResponse(
      "Authorization could not be completed. Start a new connection link.",
      400,
    );
  }
}

export function startMcpAuthServer(): void {
  if (authServer !== undefined) {
    return;
  }

  const configuredPort = Bun.env.BELLACLAW_MCP_AUTH_PORT?.trim();
  let port = 3080;
  if (configuredPort !== undefined && configuredPort.length > 0) {
    port = Number(configuredPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("BELLACLAW_MCP_AUTH_PORT must be an integer from 1 to 65535");
    }
  }

  authServer = Bun.serve({ port, fetch: handleMcpAuthCallback });
}

export async function stopMcpAuthServer(): Promise<void> {
  if (authServer === undefined) {
    return;
  }
  await authServer.stop();
  authServer = undefined;
}

function callbackUrl(): string {
  const publicUrl = Bun.env.BELLACLAW_MCP_PUBLIC_URL?.trim();
  if (publicUrl === undefined || publicUrl.length === 0) {
    throw new Error("BELLACLAW_MCP_PUBLIC_URL is required for MCP OAuth");
  }
  return new URL(CALLBACK_PATH, `${publicUrl.replace(/\/$/, "")}/`).toString();
}

// a stored connector: oauth and tokenAuth both set, which a file connector cannot have
export function choosesCredentials(connector: TConnector): boolean {
  return (
    connector.transport.type === "http" &&
    connector.transport.oauth !== undefined &&
    connector.transport.tokenAuth
  );
}

function usesChatCredentials(connector: TConnector): boolean {
  return (
    connector.transport.type === "http" &&
    (connector.transport.oauth !== undefined || connector.transport.tokenAuth)
  );
}

function credentialKey(chatId: string, connector: TConnector): string {
  if (connector.transport.type !== "http" || !usesChatCredentials(connector)) {
    throw new Error(`Connector ${connector.id} does not use OAuth or tokenAuth`);
  }

  const clientIdEnv = connector.transport.oauth?.clientIdEnv;
  const clientSecretEnv = connector.transport.oauth?.clientSecretEnv;
  let clientId: TOption<string>;
  let clientSecret: TOption<string>;

  if (clientIdEnv !== undefined) {
    clientId = Bun.env[clientIdEnv];
  }

  if (clientSecretEnv !== undefined) {
    clientSecret = Bun.env[clientSecretEnv];
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        url: connector.transport.url,
        scopes: connector.transport.oauth?.scopes,
        authorizationParams: connector.transport.oauth?.authorizationParams,
        clientIdEnv,
        clientId,
        clientSecretEnv,
        clientSecret,
      }),
    )
    .digest("base64url")
    .slice(0, 16);
  return `${encodeURIComponent(chatId)}:${connector.id}:${fingerprint}`;
}

function authQueue(key: string): AsyncQueue {
  const existing = authQueues.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const queue = new AsyncQueue();
  authQueues.set(key, queue);
  return queue;
}

function advanceAuthGeneration(key: string): number {
  const generation = currentAuthGeneration(key) + 1;
  authGenerations.set(key, generation);
  return generation;
}

function currentAuthGeneration(key: string): number {
  return authGenerations.get(key) ?? 0;
}

class McpFetchResponse extends Response {
  private readonly compatibleHeaders: Headers;

  public constructor(response: TCachedResponse | Awaited<ReturnType<typeof fetch>>) {
    super(response.body, response);
    this.compatibleHeaders = new Headers(response.headers);
  }

  public override get headers(): Headers {
    return this.compatibleHeaders;
  }
}

function callbackResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export { McpAuthCredentialStore } from "./store";
