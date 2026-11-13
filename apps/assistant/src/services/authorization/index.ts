import { AppLogger, EBehaviorLogLevel, type TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { createLogger, type TLogger } from "@bellaclaw/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DatabaseConnector, type TDatabaseHandle } from "../database";
import { messageAuthorizationsTable } from "../database/schema";
import { ESubscriptionMode, EventBus, type TEventContext } from "../events";
import { EEventType, type TEvent } from "../events/catalog";
import {
  EAuthorizationDecision,
  EAuthorizationStatus,
  SAuthorizationState,
  type TAuthorizationState,
} from "./schema";

const MAX_FAILED_ATTEMPTS = 3;

export type TAuthorizationResult = {
  decision: EAuthorizationDecision;
  failedAttempts: number;
  nextState: TOption<TAuthorizationState>;
};

export class AuthorizationService {
  private static _instance: TOption<AuthorizationService>;
  private logger: TLogger = createLogger("AUTHORIZATION");
  private database = DatabaseConnector.instance;
  private cache = new Map<string, TAuthorizationState>();
  private activationToken: TOption<string>;
  private loadPromise: TOption<Promise<void>>;

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

  // NOTE: the cache has its own consumer, so its update never waits behind the next message on
  // the decision lane; decisions read the row for any chat the cache does not authorize
  public setup(): Promise<void> {
    const bus = EventBus.instance;

    bus.subscribe({
      consumer: "authorization",
      type: EEventType.MessageReceived,
      mode: ESubscriptionMode.Durable,
      backoffMs: [1_000, 5_000],
      handler: (event, ctx) => this.handleReceived(event, ctx),
    });
    bus.subscribe({
      consumer: "authorization-cache",
      type: EEventType.AuthorizationChanged,
      mode: ESubscriptionMode.Live,
      backoffMs: [],
      handler: async (event) => {
        this.cache.set(event.payload.chatId, event.payload);
      },
    });

    return this.load();
  }

  public async listAuthorizedChatIds(): Promise<string[]> {
    await this.load();

    return [...this.cache.values()]
      .filter((state) => state.status === EAuthorizationStatus.Authorized)
      .map((state) => state.chatId);
  }

  // NOTE: a chat that is not authorized in the cache is read from the handle, so the decision
  // never depends on when authorization.changed reaches the cache
  public async authorize(
    db: TDatabaseHandle,
    chatId: string,
    content: string,
  ): Promise<TAuthorizationResult> {
    if (this.activationToken === undefined) {
      return {
        decision: EAuthorizationDecision.Allow,
        failedAttempts: 0,
        nextState: undefined,
      };
    }

    const normalizedContent = content.trim();
    let current = this.cache.get(chatId);

    if (current?.status !== EAuthorizationStatus.Authorized) {
      const rows = await db
        .select()
        .from(messageAuthorizationsTable)
        .where(eq(messageAuthorizationsTable.chatId, chatId));
      const parsed = z.array(SAuthorizationState).safeParse(rows);

      if (!parsed.success) {
        throw new Error(`Invalid authorization state in database: ${parsed.error.message}`);
      }

      current = parsed.data[0];
    }

    if (current?.status === EAuthorizationStatus.Authorized) {
      if (normalizedContent === this.activationToken) {
        return {
          decision: EAuthorizationDecision.AlreadyActivated,
          failedAttempts: 0,
          nextState: undefined,
        };
      }

      return {
        decision: EAuthorizationDecision.Allow,
        failedAttempts: 0,
        nextState: undefined,
      };
    }

    if (current?.status === EAuthorizationStatus.Locked) {
      return {
        decision: EAuthorizationDecision.Locked,
        failedAttempts: MAX_FAILED_ATTEMPTS,
        nextState: undefined,
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

    await db
      .insert(messageAuthorizationsTable)
      .values(nextState)
      .onConflictDoUpdate({
        target: messageAuthorizationsTable.chatId,
        set: {
          status: nextState.status,
          failedAttempts: nextState.failedAttempts,
        },
      });

    return {
      decision,
      failedAttempts,
      nextState,
    };
  }

  private async handleReceived(
    event: TEvent<EEventType.MessageReceived>,
    ctx: TEventContext,
  ): Promise<void> {
    const { chatId, content } = event.payload;

    const result = await ctx.complete(async (tx, emit) => {
      const result = await this.authorize(tx, chatId, content);

      if (result.nextState !== undefined) {
        emit(EEventType.AuthorizationChanged, result.nextState, undefined, undefined);
      }

      if (result.decision === EAuthorizationDecision.Allow) {
        emit(EEventType.MessageAuthorized, event.payload, undefined, undefined);
        return result;
      }

      if (result.decision === EAuthorizationDecision.Activated) {
        emit(EEventType.ReplyReady, { chatId, text: "Activated." }, undefined, undefined);
        return result;
      }

      if (result.decision === EAuthorizationDecision.AlreadyActivated) {
        emit(EEventType.ReplyReady, { chatId, text: "Already activated." }, undefined, undefined);
        return result;
      }

      emit(
        EEventType.MessageRejected,
        { chatId, decision: result.decision, failedAttempts: result.failedAttempts },
        undefined,
        undefined,
      );
      return result;
    });

    if (result.decision === EAuthorizationDecision.Allow) {
      logMessageReceived(event.trace, event.payload.platform, content.length);
      return;
    }

    logAuthorizationDecision(event.trace, result);
  }

  private load(): Promise<void> {
    if (this.loadPromise === undefined) {
      this.loadPromise = this.loadAuthorizationStates();
    }

    return this.loadPromise;
  }

  private async loadAuthorizationStates(): Promise<void> {
    if (this.activationToken === undefined) {
      this.logger.warning(
        "BELLACLAW_ACTIVATION_TOKEN is empty; inbound authorization gate is disabled",
      );
      return;
    }

    const rows = await this.database.run(async (db) => {
      return db.select().from(messageAuthorizationsTable);
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

function logAuthorizationDecision(trace: TBehaviorTraceContext, result: TAuthorizationResult) {
  let level = EBehaviorLogLevel.Info;

  if (
    result.decision === EAuthorizationDecision.FailedAttempt ||
    result.decision === EAuthorizationDecision.Locked
  ) {
    level = EBehaviorLogLevel.Warning;
  }

  AppLogger.instance.record({
    trace,
    event: `authorization.${result.decision}`,
    component: "authorization",
    level,
    success:
      result.decision === EAuthorizationDecision.Activated ||
      result.decision === EAuthorizationDecision.AlreadyActivated,
    summary: `authorization ${result.decision}`,
    metadata: {
      decision: result.decision,
      failedAttempts: result.failedAttempts,
    },
  });
}

function logMessageReceived(trace: TBehaviorTraceContext, platform: string, chars: number) {
  AppLogger.instance.record({
    trace,
    event: "message.received",
    component: "messaging",
    summary: `message received platform=${platform}`,
    metadata: {
      platform,
      messageChars: chars,
    },
  });
}
