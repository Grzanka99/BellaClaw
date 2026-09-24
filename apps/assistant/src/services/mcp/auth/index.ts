import { createHash, randomBytes } from "node:crypto";
import { AsyncQueue, logger, type TOption } from "@bellaclaw/shared";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getMcpProfile, type TMcpProfile } from "../config";
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
const disconnectListeners = new Set<TDisconnectListener>();
const connectedListeners = new Set<TConnectedListener>();
const runtimeProviders = new Map<string, { generation: number; provider: OAuthClientProvider }>();
const refreshRequests = new Map<string, Promise<TCachedResponse>>();
const authQueues = new Map<string, AsyncQueue>();
const authGenerations = new Map<string, number>();
let authServer: TOption<ReturnType<typeof Bun.serve>>;

type TPendingState = {
  chatId: string;
  profileId: string;
  key: string;
  generation: number;
  expiresAt: number;
};

type TDisconnectListener = (chatId: string, profileId: string) => void | Promise<void>;

type TConnectedListener = (chatId: string, profileId: string) => void | Promise<void>;

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
    private readonly profile: TMcpProfile,
    private readonly store: McpAuthCredentialStore,
    private readonly onAuthorization: TOption<TAuthorizationRedirect>,
    private readonly generation: number,
    private readonly writesAlreadyQueued: boolean,
  ) {
    this.key = credentialKey(chatId, profile);
  }

  public get redirectUrl(): string {
    return callbackUrl();
  }

  public get clientMetadata(): OAuthClientMetadata {
    let scope: TOption<string>;
    if (this.profile.transport.type === "http" && this.profile.transport.oauth !== undefined) {
      scope = this.profile.transport.oauth.scopes.join(" ");
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
    if (this.profile.transport.type !== "http" || this.profile.transport.oauth === undefined) {
      return undefined;
    }

    const clientIdEnv = this.profile.transport.oauth.clientIdEnv;
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
    const clientSecretEnv = this.profile.transport.oauth.clientSecretEnv;
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
        `MCP profile ${this.profile.id} needs authentication. Run !mcp-auth connect ${this.profile.id}`,
      );
    }
    this.assertCurrentGeneration();
    if (this.profile.transport.type !== "http" || this.profile.transport.oauth === undefined) {
      throw new Error(`MCP profile ${this.profile.id} does not use OAuth`);
    }
    for (const [name, value] of Object.entries(this.profile.transport.oauth.authorizationParams)) {
      if (RESERVED_AUTHORIZATION_PARAMS.has(name) || authorizationUrl.searchParams.has(name)) {
        throw new Error(`MCP OAuth authorization parameter ${name} is reserved`);
      }
      authorizationUrl.searchParams.append(name, value);
    }

    pendingStates.set(this.authorizationState, {
      chatId: this.chatId,
      profileId: this.profile.id,
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
      throw new Error(`MCP authentication for profile ${this.profile.id} was cancelled`);
    }
  }
}

export async function getMcpAuthProvider(
  chatId: string,
  profile: TMcpProfile,
): Promise<TOption<OAuthClientProvider>> {
  if (profile.transport.type !== "http" || profile.transport.oauth === undefined) {
    return undefined;
  }
  const key = credentialKey(chatId, profile);
  const generation = currentAuthGeneration(key);
  const existing = runtimeProviders.get(key);
  if (existing !== undefined && existing.generation === generation) {
    return existing.provider;
  }

  const provider = new McpOAuthClientProvider(
    chatId,
    profile,
    credentialStore,
    undefined,
    generation,
    false,
  );
  runtimeProviders.set(key, { generation, provider });
  return provider;
}

export async function beginMcpAuth(chatId: string, profileId: string): Promise<string> {
  const profile = await getMcpProfile(profileId);
  if (profile.transport.type !== "http" || profile.transport.oauth === undefined) {
    throw new Error(`MCP profile ${profileId} does not use OAuth`);
  }

  const key = credentialKey(chatId, profile);
  const generation = advanceAuthGeneration(key);
  runtimeProviders.delete(key);
  const serverUrl = profile.transport.url;
  const authorizationUrl = await authQueue(key).enqueue(async () => {
    if (currentAuthGeneration(key) !== generation) {
      throw new Error(`MCP authentication for profile ${profileId} was cancelled`);
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
      profile,
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
    for (const listener of disconnectListeners) {
      await listener(chatId, profileId);
    }
    throw new Error(`MCP profile ${profileId} is already connected`);
  }
  return authorizationUrl;
}

export async function getMcpAuthStatus(chatId: string, profileId: string): Promise<boolean> {
  const profile = await getMcpProfile(profileId);
  if (profile.transport.type !== "http" || profile.transport.oauth === undefined) {
    throw new Error(`MCP profile ${profileId} does not use OAuth`);
  }
  return credentialStore.hasTokens(credentialKey(chatId, profile));
}

export async function disconnectMcpAuth(chatId: string, profileId: string): Promise<boolean> {
  const profile = await getMcpProfile(profileId);
  if (profile.transport.type !== "http" || profile.transport.oauth === undefined) {
    throw new Error(`MCP profile ${profileId} does not use OAuth`);
  }

  const key = credentialKey(chatId, profile);
  advanceAuthGeneration(key);
  runtimeProviders.delete(key);
  for (const [state, pending] of pendingStates) {
    if (pending.key === key) {
      pendingStates.delete(state);
    }
  }

  const deleted = await authQueue(key).enqueue(() => credentialStore.delete(key));
  for (const listener of disconnectListeners) {
    await listener(chatId, profileId);
  }
  return deleted;
}

export function registerMcpAuthDisconnectListener(listener: TDisconnectListener): () => void {
  disconnectListeners.add(listener);
  return () => disconnectListeners.delete(listener);
}

export function registerMcpAuthConnectedListener(listener: TConnectedListener): () => void {
  connectedListeners.add(listener);
  return () => connectedListeners.delete(listener);
}

export function createMcpAuthFetch(chatId: string, profileId: string): FetchLike {
  const key = `${encodeURIComponent(chatId)}:${profileId}`;
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
      const profile = await getMcpProfile(pending.profileId);
      if (profile.transport.type !== "http" || profile.transport.oauth === undefined) {
        throw new Error(`MCP profile ${pending.profileId} does not use OAuth`);
      }
      if (credentialKey(pending.chatId, profile) !== pending.key) {
        throw new Error("MCP OAuth configuration changed during authorization");
      }
      const provider = new McpOAuthClientProvider(
        pending.chatId,
        profile,
        credentialStore,
        undefined,
        pending.generation,
        true,
      );
      await auth(provider, { serverUrl: profile.transport.url, authorizationCode: code });
      if (currentAuthGeneration(pending.key) !== pending.generation) {
        throw new Error("MCP OAuth callback was cancelled");
      }
    });
    for (const listener of connectedListeners) {
      try {
        await listener(pending.chatId, pending.profileId);
      } catch (_error) {
        logger.warning("MCP OAuth connection notification could not be delivered");
      }
    }
    return callbackResponse(
      `Connected MCP profile ${pending.profileId}. You can close this window.`,
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

function credentialKey(chatId: string, profile: TMcpProfile): string {
  if (profile.transport.type !== "http" || profile.transport.oauth === undefined) {
    throw new Error(`MCP profile ${profile.id} does not use OAuth`);
  }

  const clientIdEnv = profile.transport.oauth.clientIdEnv;
  const clientSecretEnv = profile.transport.oauth.clientSecretEnv;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        url: profile.transport.url,
        scopes: profile.transport.oauth.scopes,
        authorizationParams: profile.transport.oauth.authorizationParams,
        clientIdEnv,
        clientId: clientIdEnv === undefined ? undefined : Bun.env[clientIdEnv],
        clientSecretEnv,
        clientSecret: clientSecretEnv === undefined ? undefined : Bun.env[clientSecretEnv],
      }),
    )
    .digest("base64url")
    .slice(0, 16);
  return `${encodeURIComponent(chatId)}:${profile.id}:${fingerprint}`;
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
