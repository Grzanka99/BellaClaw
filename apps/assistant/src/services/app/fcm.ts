import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_LIFETIME_S = 3600;
// a cached access token is renewed this long before it expires
const TOKEN_RENEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

const SServiceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().min(1),
});

const SAccessToken = z.object({ access_token: z.string().min(1), expires_in: z.number() });

const SFcmError = z.object({
  error: z.object({
    details: z
      .array(
        z.object({
          errorCode: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

type TServiceAccount = z.infer<typeof SServiceAccount>;

export enum EPushResult {
  Sent = "sent",
  // FCM no longer knows the token: its device is gone
  Unregistered = "unregistered",
}

// NOTE: FCM HTTP v1 with a service account: a JWT signed with its key is exchanged at its
// token_uri for an access token, cached until shortly before it expires
export class FcmClient {
  private accessToken: TOption<{ value: string; expiresAt: number }>;

  private constructor(
    private account: TServiceAccount,
    private signingKey: CryptoKey,
    private baseUrl: string,
  ) {}

  // path: the service-account JSON key; baseUrl: where FCM is reached. Throws when the file is
  // not such a key
  public static async load(path: string, baseUrl: string): Promise<FcmClient> {
    const parsed = SServiceAccount.safeParse(await Bun.file(path).json());

    if (!parsed.success) {
      throw new Error("The file is not a service-account key");
    }

    const der = Buffer.from(
      parsed.data.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, ""),
      "base64",
    );
    const signingKey = await crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );

    return new FcmClient(parsed.data, signingKey, baseUrl.replace(/\/+$/, ""));
  }

  // A data-only message with high priority to one registration token, carrying only the
  // ciphertext. Throws on any failure but a token FCM no longer knows
  public async send(token: string, ciphertext: string): Promise<EPushResult> {
    const accessToken = await this.authorize();
    const response = await fetch(
      `${this.baseUrl}/v1/projects/${this.account.project_id}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: { token, data: { ciphertext }, android: { priority: "HIGH" } },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (response.ok) {
      return EPushResult.Sent;
    }

    if (response.status === 401) {
      this.accessToken = undefined;
    }

    // NOTE: the error's text is never kept, it can quote the request
    const body = SFcmError.safeParse(await response.json().catch(() => undefined));
    const details = body.data?.error.details ?? [];
    const errorCodes = details.map((detail) => detail.errorCode);

    if (response.status === 404 && errorCodes.includes("UNREGISTERED")) {
      return EPushResult.Unregistered;
    }

    throw new Error(`FCM answered HTTP ${response.status} ${errorCodes.join(",")}`.trim());
  }

  private async authorize(): Promise<string> {
    if (this.accessToken !== undefined && Date.now() < this.accessToken.expiresAt) {
      return this.accessToken.value;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        iss: this.account.client_email,
        scope: SCOPE,
        aud: this.account.token_uri,
        iat: now,
        exp: now + TOKEN_LIFETIME_S,
      }),
    ).toString("base64url");
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      this.signingKey,
      encoder.encode(`${header}.${claims}`),
    );
    const response = await fetch(this.account.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${Buffer.from(signature).toString("base64url")}`,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`The token exchange answered HTTP ${response.status}`);
    }

    const parsed = SAccessToken.safeParse(await response.json());

    if (!parsed.success) {
      throw new Error("The token exchange answered no access token");
    }

    this.accessToken = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000 - TOKEN_RENEW_MS,
    };

    return this.accessToken.value;
  }
}
