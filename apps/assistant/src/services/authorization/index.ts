import { z } from "zod";
import type { TOption } from "../../types";
import { AsyncQueue } from "../../utils/async-queue";
import { createLogger, type TLogger } from "../../utils/logger";
import { DatabaseConnector } from "../database";
import { messageAuthorizationsTable } from "../database/schema";
import { EAuthorizationStatus, SAuthorizationState, type TAuthorizationState } from "./schema";

const MAX_FAILED_ATTEMPTS = 3;

export enum EAuthorizationDecision {
  Allow = "allow",
  FailedAttempt = "failed_attempt",
  Locked = "locked",
  Activated = "activated",
  AlreadyActivated = "already_activated",
}

export type TAuthorizationResult = {
  decision: EAuthorizationDecision;
  failedAttempts: number;
};

export class AuthorizationService {
  private static _instance: TOption<AuthorizationService>;
  private logger: TLogger = createLogger("AUTHORIZATION");
  private db = DatabaseConnector.instance.database;
  private queue = new AsyncQueue();
  private cache = new Map<string, TAuthorizationState>();
  private activationToken: TOption<string>;
  private setupPromise: TOption<Promise<void>>;

  private constructor() {
    const configuredToken = Bun.env.BELLACLAW_ACTIVATION_TOKEN?.trim();

    if (configuredToken !== undefined && configuredToken.length > 0) {
      this.activationToken = configuredToken;
    }
  }

  public static get instance() {
    if (!AuthorizationService._instance) {
      AuthorizationService._instance = new AuthorizationService();
    }

    return AuthorizationService._instance;
  }

  public setup(): Promise<void> {
    if (this.setupPromise === undefined) {
      this.setupPromise = this.loadAuthorizationStates();
    }

    return this.setupPromise;
  }

  public async authorize(chatId: string, content: string): Promise<TAuthorizationResult> {
    await this.setup();

    if (this.activationToken === undefined) {
      return {
        decision: EAuthorizationDecision.Allow,
        failedAttempts: 0,
      };
    }

    const normalizedContent = content.trim();
    const cached = this.cache.get(chatId);

    if (cached?.status === EAuthorizationStatus.Authorized) {
      if (normalizedContent === this.activationToken) {
        return {
          decision: EAuthorizationDecision.AlreadyActivated,
          failedAttempts: 0,
        };
      }

      return {
        decision: EAuthorizationDecision.Allow,
        failedAttempts: 0,
      };
    }

    if (cached?.status === EAuthorizationStatus.Locked) {
      return {
        decision: EAuthorizationDecision.Locked,
        failedAttempts: MAX_FAILED_ATTEMPTS,
      };
    }

    return this.queue.enqueue(async () => {
      const current = this.cache.get(chatId);

      if (current?.status === EAuthorizationStatus.Authorized) {
        if (normalizedContent === this.activationToken) {
          return {
            decision: EAuthorizationDecision.AlreadyActivated,
            failedAttempts: 0,
          };
        }

        return {
          decision: EAuthorizationDecision.Allow,
          failedAttempts: 0,
        };
      }

      if (current?.status === EAuthorizationStatus.Locked) {
        return {
          decision: EAuthorizationDecision.Locked,
          failedAttempts: MAX_FAILED_ATTEMPTS,
        };
      }

      let status = EAuthorizationStatus.Authorized;
      let failedAttempts = 0;
      let decision = EAuthorizationDecision.Activated;

      if (normalizedContent !== this.activationToken) {
        failedAttempts = (current?.failedAttempts ?? 0) + 1;
        status = EAuthorizationStatus.Pending;
        decision = EAuthorizationDecision.FailedAttempt;

        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
          failedAttempts = MAX_FAILED_ATTEMPTS;
          status = EAuthorizationStatus.Locked;
          decision = EAuthorizationDecision.Locked;
        }
      }

      const nextState: TAuthorizationState = {
        chatId,
        status,
        failedAttempts,
      };

      await this.db
        .insert(messageAuthorizationsTable)
        .values(nextState)
        .onConflictDoUpdate({
          target: messageAuthorizationsTable.chatId,
          set: {
            status: nextState.status,
            failedAttempts: nextState.failedAttempts,
          },
        });

      this.cache.set(chatId, nextState);

      return {
        decision,
        failedAttempts,
      };
    });
  }

  private async loadAuthorizationStates(): Promise<void> {
    if (this.activationToken === undefined) {
      this.logger.warning(
        "BELLACLAW_ACTIVATION_TOKEN is empty; inbound authorization gate is disabled",
      );
      return;
    }

    const rows = await this.queue.enqueue(async () => {
      return this.db.select().from(messageAuthorizationsTable);
    });
    const parsed = z.array(SAuthorizationState).safeParse(rows);

    if (!parsed.success) {
      throw new Error(`Invalid authorization state in database: ${parsed.error.message}`);
    }

    for (const state of parsed.data) {
      this.cache.set(state.chatId, state);
    }
  }
}
