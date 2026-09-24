import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

let directory: string;
let oauthServer: ReturnType<typeof Bun.serve>;
let service: typeof import(".");
let profile: Awaited<ReturnType<typeof import("../config").getMcpProfile>>;
let refreshes = 0;
let blockedTokenExchange: Promise<void> | undefined;
let markTokenExchangeStarted: (() => void) | undefined;
let blockedRefreshExchange: Promise<void> | undefined;
let markRefreshExchangeStarted: (() => void) | undefined;

const previousConfigPath = Bun.env.BELLACLAW_MCP_CONFIG;
const previousCredentialsPath = Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
const previousPublicUrl = Bun.env.BELLACLAW_MCP_PUBLIC_URL;
const previousClientId = Bun.env.BELLACLAW_TEST_MCP_CLIENT_ID;
const previousClientSecret = Bun.env.BELLACLAW_TEST_MCP_CLIENT_SECRET;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bellaclaw-mcp-auth-"));
  oauthServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${oauthServer.port}`;

      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["documents.read"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        if (body.get("code") === "blocked" && blockedTokenExchange !== undefined) {
          markTokenExchangeStarted?.();
          await blockedTokenExchange;
        }
        if (body.get("grant_type") === "refresh_token") {
          markRefreshExchangeStarted?.();
          if (blockedRefreshExchange !== undefined) {
            await blockedRefreshExchange;
          }
          refreshes += 1;
          return Response.json({
            access_token: `refreshed-${refreshes}`,
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        return Response.json({
          access_token: `access-${body.get("code")}`,
          refresh_token: `refresh-${body.get("code")}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const origin = `http://127.0.0.1:${oauthServer.port}`;
  const configPath = join(directory, "mcp.json");
  await writeFile(
    configPath,
    JSON.stringify({
      profiles: [
        {
          id: "documents",
          description: "Test documents",
          instructions: "Read test documents.",
          transport: {
            type: "http",
            url: `${origin}/mcp`,
            oauth: {
              clientIdEnv: "BELLACLAW_TEST_MCP_CLIENT_ID",
              clientSecretEnv: "BELLACLAW_TEST_MCP_CLIENT_SECRET",
              scopes: ["documents.read"],
              authorizationParams: { access_type: "offline", prompt: "consent" },
            },
          },
        },
        {
          id: "reserved-parameter",
          description: "Invalid test profile",
          instructions: "Test reserved authorization parameters.",
          transport: {
            type: "http",
            url: `${origin}/mcp`,
            oauth: {
              clientIdEnv: "BELLACLAW_TEST_MCP_CLIENT_ID",
              clientSecretEnv: "BELLACLAW_TEST_MCP_CLIENT_SECRET",
              scopes: ["documents.read"],
              authorizationParams: { state: "configured-state" },
            },
          },
        },
      ],
    }),
  );
  Bun.env.BELLACLAW_MCP_CONFIG = configPath;
  Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = join(directory, "credentials.json");
  Bun.env.BELLACLAW_MCP_PUBLIC_URL = "http://localhost:3080";
  Bun.env.BELLACLAW_TEST_MCP_CLIENT_ID = "test-client";
  Bun.env.BELLACLAW_TEST_MCP_CLIENT_SECRET = "test-secret";

  service = await import(".");
  const config = await import("../config");
  profile = await config.getMcpProfile("documents");
});

afterAll(async () => {
  oauthServer.stop(true);
  await rm(directory, { recursive: true, force: true });
  if (previousConfigPath === undefined) {
    delete Bun.env.BELLACLAW_MCP_CONFIG;
  } else {
    Bun.env.BELLACLAW_MCP_CONFIG = previousConfigPath;
  }
  if (previousCredentialsPath === undefined) {
    delete Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
  } else {
    Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH = previousCredentialsPath;
  }
  if (previousPublicUrl === undefined) {
    delete Bun.env.BELLACLAW_MCP_PUBLIC_URL;
  } else {
    Bun.env.BELLACLAW_MCP_PUBLIC_URL = previousPublicUrl;
  }
  if (previousClientId === undefined) {
    delete Bun.env.BELLACLAW_TEST_MCP_CLIENT_ID;
  } else {
    Bun.env.BELLACLAW_TEST_MCP_CLIENT_ID = previousClientId;
  }
  if (previousClientSecret === undefined) {
    delete Bun.env.BELLACLAW_TEST_MCP_CLIENT_SECRET;
  } else {
    Bun.env.BELLACLAW_TEST_MCP_CLIENT_SECRET = previousClientSecret;
  }
});

describe("MCP OAuth", () => {
  test("binds one-time callback state to the initiating chat", async () => {
    const firstUrl = new URL(await service.beginMcpAuth("signal:first", "documents"));
    const secondUrl = new URL(await service.beginMcpAuth("discord:second", "documents"));
    const firstState = firstUrl.searchParams.get("state");
    const secondState = secondUrl.searchParams.get("state");

    expect(firstState).toBeTruthy();
    expect(secondState).toBeTruthy();
    expect(firstState).not.toBe(secondState);
    expect(firstUrl.searchParams.get("access_type")).toBe("offline");
    expect(firstUrl.searchParams.get("prompt")).toBe("consent");

    const firstCallback = await service.handleMcpAuthCallback(
      new Request(`http://localhost:3080/mcp/oauth/callback?code=first&state=${firstState}`),
    );
    expect(firstCallback.status).toBe(200);
    expect(await service.getMcpAuthStatus("signal:first", "documents")).toBe(true);
    expect(await service.getMcpAuthStatus("discord:second", "documents")).toBe(false);

    const replay = await service.handleMcpAuthCallback(
      new Request(`http://localhost:3080/mcp/oauth/callback?code=replay&state=${firstState}`),
    );
    expect(replay.status).toBe(400);

    const secondCallback = await service.handleMcpAuthCallback(
      new Request(`http://localhost:3080/mcp/oauth/callback?code=second&state=${secondState}`),
    );
    expect(secondCallback.status).toBe(200);
    expect(await service.getMcpAuthStatus("discord:second", "documents")).toBe(true);
  });

  test("closes the runtime session when starting authentication fails", async () => {
    const chatId = "signal:reserved";
    const config = await import("../config");
    const reservedProfile = await config.getMcpProfile("reserved-parameter");
    const provider = await service.getMcpAuthProvider(chatId, reservedProfile);
    expect(provider).toBeDefined();
    if (provider === undefined) {
      throw new Error("Missing OAuth provider");
    }
    const disconnected: string[] = [];
    const unregister = service.registerMcpAuthDisconnectListener(
      (disconnectedChatId, profileId) => {
        disconnected.push(`${disconnectedChatId}/${profileId}`);
      },
    );

    try {
      await expect(service.beginMcpAuth(chatId, "reserved-parameter")).rejects.toThrow(
        "OAuth authorization parameter state is reserved",
      );
      expect(disconnected).toEqual([`${chatId}/reserved-parameter`]);
      await expect(provider.tokens()).rejects.toThrow(
        "MCP authentication for profile reserved-parameter was cancelled",
      );
    } finally {
      unregister();
    }
  });

  test("persists credentials with restrictive permissions and refreshes through the SDK", async () => {
    const credentialsPath = Bun.env.BELLACLAW_MCP_CREDENTIALS_PATH;
    expect(credentialsPath).toBeTruthy();
    if (credentialsPath === undefined) {
      throw new Error("Missing test credentials path");
    }

    expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    const stored = await readFile(credentialsPath, "utf8");
    expect(stored).toContain("refresh-first");

    const provider = await service.getMcpAuthProvider("signal:first", profile);
    expect(provider).toBeDefined();
    if (provider === undefined) {
      throw new Error("Missing OAuth provider");
    }
    const serverUrl = profile.transport.type === "http" ? profile.transport.url : "";
    const refreshFetch = service.createMcpAuthFetch("signal:first", "documents");
    await Promise.all([
      auth(provider, { serverUrl, fetchFn: refreshFetch }),
      auth(provider, { serverUrl, fetchFn: refreshFetch }),
    ]);
    expect(refreshes).toBe(1);
    expect((await provider.tokens())?.access_token).toBe("refreshed-1");
  });

  test("disconnect removes only that chat and invalidates its runtime session", async () => {
    const disconnected: string[] = [];
    const unregister = service.registerMcpAuthDisconnectListener((chatId, profileId) => {
      disconnected.push(`${chatId}/${profileId}`);
    });

    expect(await service.disconnectMcpAuth("signal:first", "documents")).toBe(true);
    expect(await service.getMcpAuthStatus("signal:first", "documents")).toBe(false);
    expect(await service.getMcpAuthStatus("discord:second", "documents")).toBe(true);
    expect(disconnected).toEqual(["signal:first/documents"]);
    unregister();
  });

  test("starting a new connection invalidates the previous link", async () => {
    const firstUrl = new URL(await service.beginMcpAuth("signal:replacement", "documents"));
    const secondUrl = new URL(await service.beginMcpAuth("signal:replacement", "documents"));

    const firstCallback = await service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=old&state=${firstUrl.searchParams.get("state")}`,
      ),
    );
    expect(firstCallback.status).toBe(400);

    const secondCallback = await service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=new&state=${secondUrl.searchParams.get("state")}`,
      ),
    );
    expect(secondCallback.status).toBe(200);
    expect(await service.getMcpAuthStatus("signal:replacement", "documents")).toBe(true);
  });

  test("closes the runtime session when a connection already exists", async () => {
    const chatId = "signal:already-connected";
    const url = new URL(await service.beginMcpAuth(chatId, "documents"));
    const callback = await service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=connected&state=${url.searchParams.get("state")}`,
      ),
    );
    expect(callback.status).toBe(200);

    const provider = await service.getMcpAuthProvider(chatId, profile);
    expect(provider).toBeDefined();
    if (provider === undefined) {
      throw new Error("Missing OAuth provider");
    }
    const disconnected: string[] = [];
    const unregister = service.registerMcpAuthDisconnectListener(
      (disconnectedChatId, profileId) => {
        disconnected.push(`${disconnectedChatId}/${profileId}`);
      },
    );

    await expect(service.beginMcpAuth(chatId, "documents")).rejects.toThrow(
      "MCP profile documents is already connected",
    );
    expect(disconnected).toEqual([`${chatId}/documents`]);
    await expect(provider.tokens()).rejects.toThrow(
      "MCP authentication for profile documents was cancelled",
    );
    unregister();
  });

  test("replaces the runtime session after a successful re-authentication", async () => {
    const chatId = "signal:re-authenticated";
    const firstUrl = new URL(await service.beginMcpAuth(chatId, "documents"));
    const firstCallback = await service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=initial&state=${firstUrl.searchParams.get("state")}`,
      ),
    );
    expect(firstCallback.status).toBe(200);

    const provider = await service.getMcpAuthProvider(chatId, profile);
    expect(provider).toBeDefined();
    if (provider === undefined) {
      throw new Error("Missing OAuth provider");
    }
    if (provider.invalidateCredentials === undefined) {
      throw new Error("OAuth provider cannot invalidate credentials");
    }
    await provider.invalidateCredentials("tokens");

    const notifications: string[] = [];
    const unregisterDisconnected = service.registerMcpAuthDisconnectListener(() => {
      notifications.push("disconnected");
    });
    const unregisterConnected = service.registerMcpAuthConnectedListener(() => {
      notifications.push("connected");
    });

    try {
      const secondUrl = new URL(await service.beginMcpAuth(chatId, "documents"));
      expect(notifications).toEqual(["disconnected"]);
      const secondCallback = await service.handleMcpAuthCallback(
        new Request(
          `http://localhost:3080/mcp/oauth/callback?code=re-authenticated&state=${secondUrl.searchParams.get("state")}`,
        ),
      );

      expect(secondCallback.status).toBe(200);
      expect(notifications).toEqual(["disconnected", "connected"]);
      await expect(provider.tokens()).rejects.toThrow(
        "MCP authentication for profile documents was cancelled",
      );
    } finally {
      unregisterDisconnected();
      unregisterConnected();
    }
  });

  test("rejects a callback when the OAuth configuration changed", async () => {
    const url = new URL(await service.beginMcpAuth("signal:changed-config", "documents"));
    Bun.env.BELLACLAW_TEST_MCP_CLIENT_SECRET = "changed-secret";

    try {
      const callback = await service.handleMcpAuthCallback(
        new Request(
          `http://localhost:3080/mcp/oauth/callback?code=changed&state=${url.searchParams.get("state")}`,
        ),
      );

      expect(callback.status).toBe(400);
      expect(await service.getMcpAuthStatus("signal:changed-config", "documents")).toBe(false);
    } finally {
      Bun.env.BELLACLAW_TEST_MCP_CLIENT_SECRET = "test-secret";
    }
  });

  test("reports a successful callback when chat notification fails", async () => {
    const connected: string[] = [];
    const unregister = service.registerMcpAuthConnectedListener((chatId, profileId) => {
      connected.push(`${chatId}/${profileId}`);
      throw new Error("delivery failed");
    });
    const url = new URL(await service.beginMcpAuth("signal:notification", "documents"));

    const callback = await service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=notification&state=${url.searchParams.get("state")}`,
      ),
    );

    expect(callback.status).toBe(200);
    expect(connected).toEqual(["signal:notification/documents"]);
    expect(await service.getMcpAuthStatus("signal:notification", "documents")).toBe(true);
    unregister();
  });

  test("disconnect wins over an in-flight callback", async () => {
    let releaseTokenExchange: () => void = () => undefined;
    blockedTokenExchange = new Promise((resolve) => {
      releaseTokenExchange = resolve;
    });
    let markStarted: () => void = () => undefined;
    const tokenExchangeStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    markTokenExchangeStarted = markStarted;

    const url = new URL(await service.beginMcpAuth("signal:race", "documents"));
    const callback = service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=blocked&state=${url.searchParams.get("state")}`,
      ),
    );
    await tokenExchangeStarted;
    const disconnect = service.disconnectMcpAuth("signal:race", "documents");
    releaseTokenExchange();

    expect((await callback).status).toBe(400);
    expect(await disconnect).toBe(true);
    expect(await service.getMcpAuthStatus("signal:race", "documents")).toBe(false);
    blockedTokenExchange = undefined;
    markTokenExchangeStarted = undefined;
  });

  test("disconnect wins over an in-flight token refresh", async () => {
    const chatId = "signal:refresh-race";
    const url = new URL(await service.beginMcpAuth(chatId, "documents"));
    const callback = await service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=refresh-race&state=${url.searchParams.get("state")}`,
      ),
    );
    expect(callback.status).toBe(200);

    const provider = await service.getMcpAuthProvider(chatId, profile);
    expect(provider).toBeDefined();
    if (provider === undefined) {
      throw new Error("Missing OAuth provider");
    }

    let releaseRefreshExchange: () => void = () => undefined;
    blockedRefreshExchange = new Promise((resolve) => {
      releaseRefreshExchange = resolve;
    });
    let markStarted: () => void = () => undefined;
    const refreshExchangeStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    markRefreshExchangeStarted = markStarted;

    const serverUrl = profile.transport.type === "http" ? profile.transport.url : "";
    const refreshing = auth(provider, {
      serverUrl,
      fetchFn: service.createMcpAuthFetch(chatId, "documents"),
    });
    await refreshExchangeStarted;
    const disconnect = service.disconnectMcpAuth(chatId, "documents");
    releaseRefreshExchange();

    await expect(refreshing).rejects.toThrow("was cancelled");
    expect(await disconnect).toBe(true);
    expect(await service.getMcpAuthStatus(chatId, "documents")).toBe(false);

    const reconnectUrl = new URL(await service.beginMcpAuth(chatId, "documents"));
    const reconnectedProvider = await service.getMcpAuthProvider(chatId, profile);
    expect(reconnectedProvider).not.toBe(provider);
    const reconnectCallback = await service.handleMcpAuthCallback(
      new Request(
        `http://localhost:3080/mcp/oauth/callback?code=reconnected&state=${reconnectUrl.searchParams.get("state")}`,
      ),
    );
    expect(reconnectCallback.status).toBe(200);
    expect(await service.getMcpAuthStatus(chatId, "documents")).toBe(true);

    blockedRefreshExchange = undefined;
    markRefreshExchangeStarted = undefined;
  });
});
