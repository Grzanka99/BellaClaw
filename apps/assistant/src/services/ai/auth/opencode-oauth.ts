import type { TOption } from "@bellaclaw/shared";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { z } from "zod";

const SERVER = "https://opencode.ai/console";
const CLIENT_ID = "opencode-cli";
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

const SDeviceCode = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri_complete: z.string().min(1),
  expires_in: z.number().positive(),
  interval: z.number().positive(),
});

const SToken = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  org_id: z.string().min(1).optional(),
});

const STokenError = z.object({ error: z.string().min(1) });
const SOrgs = z.array(z.object({ id: z.string().min(1) }));

async function postToken(body: Record<string, string>, signal: AbortSignal) {
  const response = await fetch(`${SERVER}/auth/device/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, client_id: CLIENT_ID }),
    signal,
  });
  const json: unknown = await response.json().catch(() => undefined);
  return { status: response.status, ok: response.ok, json };
}

// Inference rejects tokens without a workspace, so a login must resolve one.
async function resolveOrgId(
  accessToken: string,
  grantedOrgId: TOption<string>,
  signal: AbortSignal,
) {
  if (grantedOrgId !== undefined) {
    return grantedOrgId;
  }

  const response = await fetch(`${SERVER}/api/orgs`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal,
  });
  const orgs = SOrgs.safeParse(await response.json().catch(() => undefined));

  if (!response.ok || !orgs.success || orgs.data.length !== 1) {
    throw new Error("OpenCode login did not select a workspace");
  }

  return orgs.data[0]?.id;
}

function expiresAt(expiresIn: number | undefined): number {
  return Date.now() + (expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000;
}

// OpenCode Console OAuth 2.0 device authorization grant (RFC 8628).
export const opencodeOAuth: OAuthAuth = {
  name: "OpenCode Go",
  isSubscription: true,
  async login(interaction) {
    const response = await fetch(`${SERVER}/auth/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, supports_org_scope: true }),
      signal: interaction.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenCode device authorization failed (${response.status})`);
    }

    const device = SDeviceCode.safeParse(await response.json());

    if (!device.success) {
      throw new Error("OpenCode returned an invalid device code response");
    }

    interaction.notify({
      type: "device_code",
      userCode: device.data.user_code,
      verificationUri: new URL(device.data.verification_uri_complete, SERVER).href,
      intervalSeconds: device.data.interval,
      expiresInSeconds: device.data.expires_in,
    });

    const deadline = Date.now() + device.data.expires_in * 1000;
    let intervalMs = device.data.interval * 1000;

    while (Date.now() < deadline) {
      await raceWithAbortSignal(Bun.sleep(intervalMs), interaction.signal);
      const result = await postToken(
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.data.device_code,
        },
        interaction.signal,
      );
      const error = STokenError.safeParse(result.json);

      if (error.success && error.data.error === "authorization_pending") {
        continue;
      }

      if (error.success && error.data.error === "slow_down") {
        intervalMs += 5000;
        continue;
      }

      if (error.success) {
        throw new Error(`OpenCode login failed: ${error.data.error}`);
      }

      const token = SToken.safeParse(result.json);

      if (!result.ok || !token.success || token.data.refresh_token === undefined) {
        throw new Error(`OpenCode token exchange failed (${result.status})`);
      }

      return {
        type: "oauth",
        access: token.data.access_token,
        refresh: token.data.refresh_token,
        expires: expiresAt(token.data.expires_in),
        orgId: await resolveOrgId(token.data.access_token, token.data.org_id, interaction.signal),
      };
    }

    throw new Error("OpenCode device code expired");
  },
  async refresh(credential, signal): Promise<OAuthCredential> {
    const result = await postToken(
      { grant_type: "refresh_token", refresh_token: credential.refresh },
      signal,
    );
    const token = SToken.safeParse(result.json);

    if (!result.ok || !token.success) {
      const error = STokenError.safeParse(result.json);
      let detail = "";

      if (error.success) {
        detail = `: ${error.data.error}`;
      }

      throw new Error(`OpenCode token refresh failed (${result.status})${detail}`);
    }

    return {
      ...credential,
      access: token.data.access_token,
      refresh: token.data.refresh_token ?? credential.refresh,
      expires: expiresAt(token.data.expires_in),
      orgId: token.data.org_id ?? credential.orgId,
    };
  },
  async toAuth(credential) {
    if (typeof credential.orgId === "string") {
      return { apiKey: credential.access, headers: { "x-opencode-org-id": credential.orgId } };
    }

    return { apiKey: credential.access };
  },
};
