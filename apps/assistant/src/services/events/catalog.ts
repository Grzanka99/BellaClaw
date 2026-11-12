import type { TBehaviorTraceContext } from "@bellaclaw/behavior-logs";
import type { TOption } from "@bellaclaw/shared";
import { z } from "zod";
import { EAiProvider } from "../ai/types";
import { EAuthorizationDecision, SAuthorizationState } from "../authorization/schema";
import { EAutomationRunMode, EAutomationRunOutcome } from "../automation/runner";
import { EAutomationStatus } from "../automation/types";
import { ECronFinishedReason, ECronJobStatus, ECronJobType } from "../cron/types";
import { EMessagePlatform } from "../messaging/types";
import { EConfigKey } from "../settings/schema";

export enum EEventKind {
  Event = "event",
  Command = "command",
}

export enum EEventType {
  MessageReceived = "message.received",
  MessageAuthorized = "message.authorized",
  MessageRejected = "message.rejected",
  AuthorizationChanged = "authorization.changed",
  TurnRequested = "turn.requested",
  TurnStarted = "turn.started",
  TurnCompleted = "turn.completed",
  TurnFailed = "turn.failed",
  ReplyReady = "reply.ready",
  NoticeReady = "notice.ready",
  DeliveryReady = "delivery.ready",
  MessageSent = "message.sent",
  CronFired = "cron.fired",
  CronTaskStarted = "cron.task.started",
  CronJobScheduleRequested = "cron.job.schedule.requested",
  CronJobScheduled = "cron.job.scheduled",
  CronJobCancelRequested = "cron.job.cancel.requested",
  CronJobCancelled = "cron.job.cancelled",
  CronAutomationDetached = "cron.automation.detached",
  AutomationDeleteRequested = "automation.delete.requested",
  AutomationDeleted = "automation.deleted",
  AutomationRunRequested = "automation.run.requested",
  AutomationRunCompleted = "automation.run.completed",
  AutomationPreviewRequested = "automation.preview.requested",
  AutomationPreviewed = "automation.previewed",
  AutomationSaveRequested = "automation.save.requested",
  AutomationSaved = "automation.saved",
  AutomationStatusSetRequested = "automation.status.set.requested",
  AutomationStatusChanged = "automation.status.changed",
  McpAuthConnected = "mcp.auth.connected",
  AiAuthLoginNeeded = "ai.auth.login.needed",
  AiAuthLoginCompleted = "ai.auth.login.completed",
  AiAuthLoginFailed = "ai.auth.login.failed",
  McpAuthCredentialsChanged = "mcp.auth.credentials.changed",
  McpAuthConnectRequested = "mcp.auth.connect.requested",
  McpAuthLinkCreated = "mcp.auth.link.created",
  McpAuthDisconnectRequested = "mcp.auth.disconnect.requested",
  McpAuthDisconnected = "mcp.auth.disconnected",
  McpAuthTokenSaveRequested = "mcp.auth.token.save.requested",
  McpAuthTokenSaved = "mcp.auth.token.saved",
  AiAuthLoginRequested = "ai.auth.login.requested",
  AiAuthLoginStarted = "ai.auth.login.started",
  AiAuthLogoutRequested = "ai.auth.logout.requested",
  AiAuthLoggedOut = "ai.auth.logged_out",
  AiAuthDiagnoseRequested = "ai.auth.diagnose.requested",
  AiAuthDiagnosed = "ai.auth.diagnosed",
  MemoryFactsRefreshRequested = "memory.facts.refresh.requested",
  MemoryFactsRefreshed = "memory.facts.refreshed",
  MemoryFactRememberRequested = "memory.fact.remember.requested",
  MemoryFactRemembered = "memory.fact.remembered",
  MemoryFactsForgetRequested = "memory.facts.forget.requested",
  MemoryFactsForgotten = "memory.facts.forgotten",
  SettingsUpdateRequested = "settings.update.requested",
  SettingsChanged = "settings.changed",
  CalendarSourceAddRequested = "calendar.source.add.requested",
  CalendarSourceAdded = "calendar.source.added",
  CalendarSourceRemoveRequested = "calendar.source.remove.requested",
  CalendarSourceRemoved = "calendar.source.removed",
  CalendarEventCreateRequested = "calendar.event.create.requested",
  CalendarEventCreated = "calendar.event.created",
  CalendarEventUpdateRequested = "calendar.event.update.requested",
  CalendarEventUpdated = "calendar.event.updated",
  CalendarEventDeleteRequested = "calendar.event.delete.requested",
  CalendarEventDeleted = "calendar.event.deleted",
  CommandRejected = "command.rejected",
  EventDeadLettered = "event.dead_lettered",
  AppStarted = "app.started",
  // NOTE: test types for the bus tests; real types arrive with their phase
  TestNoted = "test.noted",
  TestSecret = "test.secret",
  TestRequested = "test.requested",
}

export enum ERejectionCode {
  Invalid = "invalid",
  Failed = "failed",
}

const STranscript = z.object({ text: z.string(), notice: z.string() }).strict();

export type TDeliveryTranscript = z.infer<typeof STranscript>;

const SInboundMessage = z
  .object({
    chatId: z.string(),
    content: z.string(),
    receivedAt: z.number().int(),
    platform: z.enum(EMessagePlatform),
  })
  .strict();

const SMessageRejected = z
  .object({
    chatId: z.string(),
    decision: z.enum([EAuthorizationDecision.FailedAttempt, EAuthorizationDecision.Locked]),
    failedAttempts: z.number().int(),
  })
  .strict();

const STurnRequested = z
  .object({
    chatId: z.string(),
    content: z.string(),
    receivedAt: z.number().int(),
    platform: z.enum(EMessagePlatform),
  })
  .strict();

const STurnStarted = z.object({ chatId: z.string(), userMessageId: z.number().int() }).strict();

const STurnCompleted = z.object({ chatId: z.string(), userMessageId: z.number().int() }).strict();

const STurnFailed = z
  .object({ chatId: z.string(), reason: z.enum(["interrupted", "no_final_response", "error"]) })
  .strict();

const SReplyReady = z
  .object({ chatId: z.string(), text: z.string(), transcript: STranscript.optional() })
  .strict();

const SNoticeReady = z.object({ chatId: z.string(), text: z.string() }).strict();

const SDeliveryReady = z
  .object({ chatId: z.string(), text: z.string(), transcript: STranscript })
  .strict();

const SMessageSent = z
  .object({
    chatId: z.string(),
    sourceType: z.string(),
    chars: z.number().int(),
    sentAt: z.number().int(),
    transcript: STranscript.optional(),
  })
  .strict();

const SJobContent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("generated"), promptData: z.string(), fallback: z.string() }).strict(),
  z.object({ kind: z.literal("task"), prompt: z.string(), fallback: z.string() }).strict(),
  z.object({ kind: z.literal("automations") }).strict(),
]);

const SCronFired = z
  .object({
    jobId: z.number().int(),
    name: z.string(),
    scope: z.string(),
    jobType: z.enum(ECronJobType),
    pattern: z.string().optional(),
    content: SJobContent,
    automationIds: z.array(z.number().int()),
    nextRunAt: z.number().int(),
    timezone: z.string().optional(),
  })
  .strict();

export type TCronFiredPayload = z.infer<typeof SCronFired>;

const SCronTaskStarted = z.object({ jobId: z.number().int() }).strict();

// a cron job with dates as epoch ms
const SCronJobRecord = z
  .object({
    id: z.number().int(),
    name: z.string(),
    scope: z.string(),
    type: z.enum(ECronJobType),
    pattern: z.string().optional(),
    content: SJobContent,
    automationIds: z.array(z.number().int()),
    nextRunAt: z.number().int(),
    lastRunAt: z.number().int().optional(),
    createdAt: z.number().int(),
    status: z.enum(ECronJobStatus),
    finishedAt: z.number().int().optional(),
    finishedReason: z.enum(ECronFinishedReason).optional(),
    timezone: z.string().optional(),
  })
  .strict();

export type TCronJobRecord = z.infer<typeof SCronJobRecord>;

const SCronJobFields = {
  name: z.string(),
  scope: z.string(),
  content: SJobContent,
  automationIds: z.array(z.number().int()),
  overwrite: z.boolean().optional(),
  timezone: z.string().optional(),
};

const SCronJobScheduleRequested = z.union([
  z.object({ ...SCronJobFields, pattern: z.string() }).strict(),
  z.object({ ...SCronJobFields, fireAt: z.number().int() }).strict(),
]);

const SCronJobChanged = z.object({ job: SCronJobRecord }).strict();

const SCronJobCancelRequested = z.object({ name: z.string(), scope: z.string() }).strict();

const SCronAutomationDetached = z
  .object({
    automationId: z.number().int(),
    updatedJobs: z.array(z.string()),
    cancelledJobs: z.array(z.string()),
  })
  .strict();

const SAutomationDeleteRequested = z.object({ scope: z.string(), name: z.string() }).strict();

const SAutomationDeleted = z
  .object({ scope: z.string(), automationId: z.number().int(), name: z.string() })
  .strict();

const SAutomationRunReport = z
  .object({
    name: z.string(),
    instructions: z.string().optional(),
    outcome: z.enum(EAutomationRunOutcome),
    text: z.string().optional(),
    data: z.unknown(),
    error: z.string().optional(),
    fetches: z.array(
      z
        .object({
          url: z.string(),
          status: z.number().int().optional(),
          bytes: z.number().int(),
          error: z.string().optional(),
        })
        .strict(),
    ),
    logs: z.array(z.string()),
    durationMs: z.number(),
    /** True only when this run's failure paused the automation. */
    paused: z.boolean(),
  })
  .strict();

export type TAutomationRunReport = z.infer<typeof SAutomationRunReport>;

const SAutomationRunRequested = z
  .object({
    scope: z.string(),
    automationId: z.number().int(),
    mode: z.enum([EAutomationRunMode.Manual, EAutomationRunMode.Cron]),
    timezone: z.string(),
  })
  .strict();

const SAutomationRunCompleted = z.object({ report: SAutomationRunReport }).strict();

const SAutomationPreviewRequested = z
  .object({
    scope: z.string(),
    name: z.string(),
    instructions: z.string().optional(),
    source: z.string(),
    config: z.record(z.string(), z.unknown()),
    allowedOrigins: z.array(z.string()),
    outputCapBytes: z.number().int().optional(),
    timezone: z.string(),
  })
  .strict();

// previewId: only a successful preview leaves a draft that can be saved
const SAutomationPreviewed = z
  .object({
    previewId: z.number().int().optional(),
    name: z.string(),
    allowedOrigins: z.array(z.string()),
    config: z.unknown(),
    outputCapBytes: z.number().int(),
    report: SAutomationRunReport,
  })
  .strict();

const SAutomationSaveRequested = z
  .object({ scope: z.string(), previewId: z.number().int() })
  .strict();

// the saved-automation fields the agents may see, without the script source
const SAutomationSummary = z
  .object({
    name: z.string(),
    status: z.enum(EAutomationStatus),
    failureCount: z.number().int(),
    lastError: z.string().optional(),
    allowedOrigins: z.array(z.string()),
    instructions: z.string().optional(),
    outputCapBytes: z.number().int(),
  })
  .strict();

const SAutomationChanged = z.object({ automation: SAutomationSummary }).strict();

const SAutomationStatusSetRequested = z
  .object({ scope: z.string(), name: z.string(), status: z.enum(EAutomationStatus) })
  .strict();

const SMcpAuthConnected = z.object({ chatId: z.string(), profileId: z.string() }).strict();

const SAiAuthLoginNeeded = z.object({ problems: z.array(z.string()) }).strict();

const SAiAuthLoginCompleted = z
  .object({ chatId: z.string(), providerId: z.string(), selected: z.boolean() })
  .strict();

const SAiAuthLoginFailed = z
  .object({ chatId: z.string(), providerId: z.string(), error: z.string() })
  .strict();

const SMcpAuthProfile = z.object({ chatId: z.string(), profileId: z.string() }).strict();

const SMcpAuthLinkCreated = z
  .object({ chatId: z.string(), profileId: z.string(), url: z.string() })
  .strict();

const SMcpAuthDisconnected = z
  .object({ chatId: z.string(), profileId: z.string(), disconnected: z.boolean() })
  .strict();

const SMcpAuthTokenSaveRequested = z
  .object({ chatId: z.string(), profileId: z.string(), token: z.string() })
  .strict();

const SAiAuthLoginRequested = z
  .object({ chatId: z.string(), providerId: z.enum(EAiProvider) })
  .strict();

const SAiAuthLoginStarted = z
  .object({ chatId: z.string(), providerId: z.string(), instructions: z.string() })
  .strict();

const SAiAuthLogoutRequested = z.object({ providerId: z.enum(EAiProvider) }).strict();

const SAiAuthDiagnoseRequested = z.object({ chatId: z.string(), providerId: z.string() }).strict();

// problem: the reply for the failed turn, when the provider needs a new login
const SAiAuthDiagnosed = z.object({ problem: z.string().optional() }).strict();

// the chat is the event key
const SMemoryFactsRefresh = z.object({}).strict();

const SMemoryFactRememberRequested = z
  .object({
    chatId: z.string(),
    text: z.string(),
    sourceMessage: z.string(),
    supersedesFactIds: z.array(z.number().int()),
  })
  .strict();

const SMemoryFactRemembered = z.object({ chatId: z.string(), factId: z.number().int() }).strict();

const SMemoryFacts = z.object({ chatId: z.string(), factIds: z.array(z.number().int()) }).strict();

const SSettingsUpdateRequested = z
  .object({
    ownerKey: z.string(),
    updates: z.array(z.object({ key: z.enum(EConfigKey), value: z.string() }).strict()),
  })
  .strict();

const SSettingsChanged = z
  .object({ ownerKey: z.string(), record: z.record(z.enum(EConfigKey), z.string()) })
  .strict();

const SCalendarAccess = z.enum(["read", "write"]);

const SCalendarSourceAddRequested = z
  .object({ chatId: z.string(), calendarId: z.string(), access: SCalendarAccess })
  .strict();

const SCalendarSourceAdded = z
  .object({
    chatId: z.string(),
    calendarId: z.string(),
    access: SCalendarAccess,
    summary: z.string().optional(),
  })
  .strict();

const SCalendarSource = z.object({ chatId: z.string(), calendarId: z.string() }).strict();

const SCalendarTransparency = z.enum(["opaque", "transparent"]);

const SCalendarEventCreateRequested = z
  .object({
    chatId: z.string(),
    summary: z.string(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.string(),
    end: z.string().optional(),
    timezone: z.string(),
    transparency: SCalendarTransparency.optional(),
    recurrence: z.array(z.string()).optional(),
  })
  .strict();

const SCalendarRecurrenceScope = z.enum(["occurrence", "following", "series"]);

const SCalendarEventUpdateRequested = z
  .object({
    chatId: z.string(),
    eventId: z.string(),
    scope: SCalendarRecurrenceScope,
    patch: z
      .object({
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        timezone: z.string().optional(),
        transparency: SCalendarTransparency.optional(),
        recurrence: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

const SCalendarEventTarget = z
  .object({ chatId: z.string(), eventId: z.string(), scope: SCalendarRecurrenceScope })
  .strict();

// event: the mapped calendar event the tool returns
const SCalendarEventChanged = z
  .object({ chatId: z.string(), event: z.record(z.string(), z.unknown()) })
  .strict();

// errorCode: the handler's stable code for an expected failure, such as job-not-found
const SCommandRejected = z
  .object({
    commandType: z.string(),
    code: z.enum(ERejectionCode),
    message: z.string(),
    errorCode: z.string().optional(),
  })
  .strict();

const SEventDeadLettered = z
  .object({
    eventId: z.string(),
    eventType: z.string(),
    consumer: z.string(),
    attempts: z.number().int(),
    error: z.string(),
  })
  .strict();

const SAppStarted = z.object({}).strict();

const STestNoted = z.object({ text: z.string(), count: z.number().int() }).strict();
const STestSecret = z.object({ secret: z.string() }).strict();
const STestRequested = z.object({ text: z.string() }).strict();

export type TEventPayloads = {
  [EEventType.MessageReceived]: z.infer<typeof SInboundMessage>;
  [EEventType.MessageAuthorized]: z.infer<typeof SInboundMessage>;
  [EEventType.MessageRejected]: z.infer<typeof SMessageRejected>;
  [EEventType.AuthorizationChanged]: z.infer<typeof SAuthorizationState>;
  [EEventType.TurnRequested]: z.infer<typeof STurnRequested>;
  [EEventType.TurnStarted]: z.infer<typeof STurnStarted>;
  [EEventType.TurnCompleted]: z.infer<typeof STurnCompleted>;
  [EEventType.TurnFailed]: z.infer<typeof STurnFailed>;
  [EEventType.ReplyReady]: z.infer<typeof SReplyReady>;
  [EEventType.NoticeReady]: z.infer<typeof SNoticeReady>;
  [EEventType.DeliveryReady]: z.infer<typeof SDeliveryReady>;
  [EEventType.MessageSent]: z.infer<typeof SMessageSent>;
  [EEventType.CronFired]: TCronFiredPayload;
  [EEventType.CronTaskStarted]: z.infer<typeof SCronTaskStarted>;
  [EEventType.CronJobScheduleRequested]: z.infer<typeof SCronJobScheduleRequested>;
  [EEventType.CronJobScheduled]: z.infer<typeof SCronJobChanged>;
  [EEventType.CronJobCancelRequested]: z.infer<typeof SCronJobCancelRequested>;
  [EEventType.CronJobCancelled]: z.infer<typeof SCronJobChanged>;
  [EEventType.CronAutomationDetached]: z.infer<typeof SCronAutomationDetached>;
  [EEventType.AutomationDeleteRequested]: z.infer<typeof SAutomationDeleteRequested>;
  [EEventType.AutomationDeleted]: z.infer<typeof SAutomationDeleted>;
  [EEventType.AutomationRunRequested]: z.infer<typeof SAutomationRunRequested>;
  [EEventType.AutomationRunCompleted]: z.infer<typeof SAutomationRunCompleted>;
  [EEventType.AutomationPreviewRequested]: z.infer<typeof SAutomationPreviewRequested>;
  [EEventType.AutomationPreviewed]: z.infer<typeof SAutomationPreviewed>;
  [EEventType.AutomationSaveRequested]: z.infer<typeof SAutomationSaveRequested>;
  [EEventType.AutomationSaved]: z.infer<typeof SAutomationChanged>;
  [EEventType.AutomationStatusSetRequested]: z.infer<typeof SAutomationStatusSetRequested>;
  [EEventType.AutomationStatusChanged]: z.infer<typeof SAutomationChanged>;
  [EEventType.McpAuthConnected]: z.infer<typeof SMcpAuthConnected>;
  [EEventType.AiAuthLoginNeeded]: z.infer<typeof SAiAuthLoginNeeded>;
  [EEventType.AiAuthLoginCompleted]: z.infer<typeof SAiAuthLoginCompleted>;
  [EEventType.AiAuthLoginFailed]: z.infer<typeof SAiAuthLoginFailed>;
  [EEventType.McpAuthCredentialsChanged]: z.infer<typeof SMcpAuthProfile>;
  [EEventType.McpAuthConnectRequested]: z.infer<typeof SMcpAuthProfile>;
  [EEventType.McpAuthLinkCreated]: z.infer<typeof SMcpAuthLinkCreated>;
  [EEventType.McpAuthDisconnectRequested]: z.infer<typeof SMcpAuthProfile>;
  [EEventType.McpAuthDisconnected]: z.infer<typeof SMcpAuthDisconnected>;
  [EEventType.McpAuthTokenSaveRequested]: z.infer<typeof SMcpAuthTokenSaveRequested>;
  [EEventType.McpAuthTokenSaved]: z.infer<typeof SMcpAuthProfile>;
  [EEventType.AiAuthLoginRequested]: z.infer<typeof SAiAuthLoginRequested>;
  [EEventType.AiAuthLoginStarted]: z.infer<typeof SAiAuthLoginStarted>;
  [EEventType.AiAuthLogoutRequested]: z.infer<typeof SAiAuthLogoutRequested>;
  [EEventType.AiAuthLoggedOut]: z.infer<typeof SAiAuthLogoutRequested>;
  [EEventType.AiAuthDiagnoseRequested]: z.infer<typeof SAiAuthDiagnoseRequested>;
  [EEventType.AiAuthDiagnosed]: z.infer<typeof SAiAuthDiagnosed>;
  [EEventType.MemoryFactsRefreshRequested]: z.infer<typeof SMemoryFactsRefresh>;
  [EEventType.MemoryFactsRefreshed]: z.infer<typeof SMemoryFactsRefresh>;
  [EEventType.MemoryFactRememberRequested]: z.infer<typeof SMemoryFactRememberRequested>;
  [EEventType.MemoryFactRemembered]: z.infer<typeof SMemoryFactRemembered>;
  [EEventType.MemoryFactsForgetRequested]: z.infer<typeof SMemoryFacts>;
  [EEventType.MemoryFactsForgotten]: z.infer<typeof SMemoryFacts>;
  [EEventType.SettingsUpdateRequested]: z.infer<typeof SSettingsUpdateRequested>;
  [EEventType.SettingsChanged]: z.infer<typeof SSettingsChanged>;
  [EEventType.CalendarSourceAddRequested]: z.infer<typeof SCalendarSourceAddRequested>;
  [EEventType.CalendarSourceAdded]: z.infer<typeof SCalendarSourceAdded>;
  [EEventType.CalendarSourceRemoveRequested]: z.infer<typeof SCalendarSource>;
  [EEventType.CalendarSourceRemoved]: z.infer<typeof SCalendarSource>;
  [EEventType.CalendarEventCreateRequested]: z.infer<typeof SCalendarEventCreateRequested>;
  [EEventType.CalendarEventCreated]: z.infer<typeof SCalendarEventChanged>;
  [EEventType.CalendarEventUpdateRequested]: z.infer<typeof SCalendarEventUpdateRequested>;
  [EEventType.CalendarEventUpdated]: z.infer<typeof SCalendarEventChanged>;
  [EEventType.CalendarEventDeleteRequested]: z.infer<typeof SCalendarEventTarget>;
  [EEventType.CalendarEventDeleted]: z.infer<typeof SCalendarEventTarget>;
  [EEventType.CommandRejected]: z.infer<typeof SCommandRejected>;
  [EEventType.EventDeadLettered]: z.infer<typeof SEventDeadLettered>;
  [EEventType.AppStarted]: z.infer<typeof SAppStarted>;
  [EEventType.TestNoted]: z.infer<typeof STestNoted>;
  [EEventType.TestSecret]: z.infer<typeof STestSecret>;
  [EEventType.TestRequested]: z.infer<typeof STestRequested>;
};

// The mapped type ties each schema to its payload type, so a handler gets a typed payload
// without a cast.
export const EVENT_SCHEMAS: { [K in EEventType]: z.ZodType<TEventPayloads[K]> } = {
  [EEventType.MessageReceived]: SInboundMessage,
  [EEventType.MessageAuthorized]: SInboundMessage,
  [EEventType.MessageRejected]: SMessageRejected,
  [EEventType.AuthorizationChanged]: SAuthorizationState,
  [EEventType.TurnRequested]: STurnRequested,
  [EEventType.TurnStarted]: STurnStarted,
  [EEventType.TurnCompleted]: STurnCompleted,
  [EEventType.TurnFailed]: STurnFailed,
  [EEventType.ReplyReady]: SReplyReady,
  [EEventType.NoticeReady]: SNoticeReady,
  [EEventType.DeliveryReady]: SDeliveryReady,
  [EEventType.MessageSent]: SMessageSent,
  [EEventType.CronFired]: SCronFired,
  [EEventType.CronTaskStarted]: SCronTaskStarted,
  [EEventType.CronJobScheduleRequested]: SCronJobScheduleRequested,
  [EEventType.CronJobScheduled]: SCronJobChanged,
  [EEventType.CronJobCancelRequested]: SCronJobCancelRequested,
  [EEventType.CronJobCancelled]: SCronJobChanged,
  [EEventType.CronAutomationDetached]: SCronAutomationDetached,
  [EEventType.AutomationDeleteRequested]: SAutomationDeleteRequested,
  [EEventType.AutomationDeleted]: SAutomationDeleted,
  [EEventType.AutomationRunRequested]: SAutomationRunRequested,
  [EEventType.AutomationRunCompleted]: SAutomationRunCompleted,
  [EEventType.AutomationPreviewRequested]: SAutomationPreviewRequested,
  [EEventType.AutomationPreviewed]: SAutomationPreviewed,
  [EEventType.AutomationSaveRequested]: SAutomationSaveRequested,
  [EEventType.AutomationSaved]: SAutomationChanged,
  [EEventType.AutomationStatusSetRequested]: SAutomationStatusSetRequested,
  [EEventType.AutomationStatusChanged]: SAutomationChanged,
  [EEventType.McpAuthConnected]: SMcpAuthConnected,
  [EEventType.AiAuthLoginNeeded]: SAiAuthLoginNeeded,
  [EEventType.AiAuthLoginCompleted]: SAiAuthLoginCompleted,
  [EEventType.AiAuthLoginFailed]: SAiAuthLoginFailed,
  [EEventType.McpAuthCredentialsChanged]: SMcpAuthProfile,
  [EEventType.McpAuthConnectRequested]: SMcpAuthProfile,
  [EEventType.McpAuthLinkCreated]: SMcpAuthLinkCreated,
  [EEventType.McpAuthDisconnectRequested]: SMcpAuthProfile,
  [EEventType.McpAuthDisconnected]: SMcpAuthDisconnected,
  [EEventType.McpAuthTokenSaveRequested]: SMcpAuthTokenSaveRequested,
  [EEventType.McpAuthTokenSaved]: SMcpAuthProfile,
  [EEventType.AiAuthLoginRequested]: SAiAuthLoginRequested,
  [EEventType.AiAuthLoginStarted]: SAiAuthLoginStarted,
  [EEventType.AiAuthLogoutRequested]: SAiAuthLogoutRequested,
  [EEventType.AiAuthLoggedOut]: SAiAuthLogoutRequested,
  [EEventType.AiAuthDiagnoseRequested]: SAiAuthDiagnoseRequested,
  [EEventType.AiAuthDiagnosed]: SAiAuthDiagnosed,
  [EEventType.MemoryFactsRefreshRequested]: SMemoryFactsRefresh,
  [EEventType.MemoryFactsRefreshed]: SMemoryFactsRefresh,
  [EEventType.MemoryFactRememberRequested]: SMemoryFactRememberRequested,
  [EEventType.MemoryFactRemembered]: SMemoryFactRemembered,
  [EEventType.MemoryFactsForgetRequested]: SMemoryFacts,
  [EEventType.MemoryFactsForgotten]: SMemoryFacts,
  [EEventType.SettingsUpdateRequested]: SSettingsUpdateRequested,
  [EEventType.SettingsChanged]: SSettingsChanged,
  [EEventType.CalendarSourceAddRequested]: SCalendarSourceAddRequested,
  [EEventType.CalendarSourceAdded]: SCalendarSourceAdded,
  [EEventType.CalendarSourceRemoveRequested]: SCalendarSource,
  [EEventType.CalendarSourceRemoved]: SCalendarSource,
  [EEventType.CalendarEventCreateRequested]: SCalendarEventCreateRequested,
  [EEventType.CalendarEventCreated]: SCalendarEventChanged,
  [EEventType.CalendarEventUpdateRequested]: SCalendarEventUpdateRequested,
  [EEventType.CalendarEventUpdated]: SCalendarEventChanged,
  [EEventType.CalendarEventDeleteRequested]: SCalendarEventTarget,
  [EEventType.CalendarEventDeleted]: SCalendarEventTarget,
  [EEventType.CommandRejected]: SCommandRejected,
  [EEventType.EventDeadLettered]: SEventDeadLettered,
  [EEventType.AppStarted]: SAppStarted,
  [EEventType.TestNoted]: STestNoted,
  [EEventType.TestSecret]: STestSecret,
  [EEventType.TestRequested]: STestRequested,
};

export const EVENT_KINDS: Record<EEventType, EEventKind> = {
  [EEventType.MessageReceived]: EEventKind.Event,
  [EEventType.MessageAuthorized]: EEventKind.Event,
  [EEventType.MessageRejected]: EEventKind.Event,
  [EEventType.AuthorizationChanged]: EEventKind.Event,
  [EEventType.TurnRequested]: EEventKind.Event,
  [EEventType.TurnStarted]: EEventKind.Event,
  [EEventType.TurnCompleted]: EEventKind.Event,
  [EEventType.TurnFailed]: EEventKind.Event,
  [EEventType.ReplyReady]: EEventKind.Event,
  [EEventType.NoticeReady]: EEventKind.Event,
  [EEventType.DeliveryReady]: EEventKind.Event,
  [EEventType.MessageSent]: EEventKind.Event,
  [EEventType.CronFired]: EEventKind.Event,
  [EEventType.CronTaskStarted]: EEventKind.Event,
  [EEventType.CronJobScheduleRequested]: EEventKind.Command,
  [EEventType.CronJobScheduled]: EEventKind.Event,
  [EEventType.CronJobCancelRequested]: EEventKind.Command,
  [EEventType.CronJobCancelled]: EEventKind.Event,
  [EEventType.CronAutomationDetached]: EEventKind.Event,
  [EEventType.AutomationDeleteRequested]: EEventKind.Command,
  [EEventType.AutomationDeleted]: EEventKind.Event,
  [EEventType.AutomationRunRequested]: EEventKind.Command,
  [EEventType.AutomationRunCompleted]: EEventKind.Event,
  [EEventType.AutomationPreviewRequested]: EEventKind.Command,
  [EEventType.AutomationPreviewed]: EEventKind.Event,
  [EEventType.AutomationSaveRequested]: EEventKind.Command,
  [EEventType.AutomationSaved]: EEventKind.Event,
  [EEventType.AutomationStatusSetRequested]: EEventKind.Command,
  [EEventType.AutomationStatusChanged]: EEventKind.Event,
  [EEventType.McpAuthConnected]: EEventKind.Event,
  [EEventType.AiAuthLoginNeeded]: EEventKind.Event,
  [EEventType.AiAuthLoginCompleted]: EEventKind.Event,
  [EEventType.AiAuthLoginFailed]: EEventKind.Event,
  [EEventType.McpAuthCredentialsChanged]: EEventKind.Event,
  [EEventType.McpAuthConnectRequested]: EEventKind.Command,
  [EEventType.McpAuthLinkCreated]: EEventKind.Event,
  [EEventType.McpAuthDisconnectRequested]: EEventKind.Command,
  [EEventType.McpAuthDisconnected]: EEventKind.Event,
  [EEventType.McpAuthTokenSaveRequested]: EEventKind.Command,
  [EEventType.McpAuthTokenSaved]: EEventKind.Event,
  [EEventType.AiAuthLoginRequested]: EEventKind.Command,
  [EEventType.AiAuthLoginStarted]: EEventKind.Event,
  [EEventType.AiAuthLogoutRequested]: EEventKind.Command,
  [EEventType.AiAuthLoggedOut]: EEventKind.Event,
  [EEventType.AiAuthDiagnoseRequested]: EEventKind.Command,
  [EEventType.AiAuthDiagnosed]: EEventKind.Event,
  [EEventType.MemoryFactsRefreshRequested]: EEventKind.Command,
  [EEventType.MemoryFactsRefreshed]: EEventKind.Event,
  [EEventType.MemoryFactRememberRequested]: EEventKind.Command,
  [EEventType.MemoryFactRemembered]: EEventKind.Event,
  [EEventType.MemoryFactsForgetRequested]: EEventKind.Command,
  [EEventType.MemoryFactsForgotten]: EEventKind.Event,
  [EEventType.SettingsUpdateRequested]: EEventKind.Command,
  [EEventType.SettingsChanged]: EEventKind.Event,
  [EEventType.CalendarSourceAddRequested]: EEventKind.Command,
  [EEventType.CalendarSourceAdded]: EEventKind.Event,
  [EEventType.CalendarSourceRemoveRequested]: EEventKind.Command,
  [EEventType.CalendarSourceRemoved]: EEventKind.Event,
  [EEventType.CalendarEventCreateRequested]: EEventKind.Command,
  [EEventType.CalendarEventCreated]: EEventKind.Event,
  [EEventType.CalendarEventUpdateRequested]: EEventKind.Command,
  [EEventType.CalendarEventUpdated]: EEventKind.Event,
  [EEventType.CalendarEventDeleteRequested]: EEventKind.Command,
  [EEventType.CalendarEventDeleted]: EEventKind.Event,
  [EEventType.CommandRejected]: EEventKind.Event,
  [EEventType.EventDeadLettered]: EEventKind.Event,
  [EEventType.AppStarted]: EEventKind.Event,
  [EEventType.TestNoted]: EEventKind.Event,
  [EEventType.TestSecret]: EEventKind.Event,
  [EEventType.TestRequested]: EEventKind.Command,
};

// payload set to NULL once no delivery of the event is pending
export const EVENT_SCRUBBED: ReadonlySet<EEventType> = new Set([
  EEventType.MessageReceived,
  EEventType.MessageAuthorized,
  EEventType.McpAuthTokenSaveRequested,
  EEventType.TestSecret,
]);

export type TEvent<T extends EEventType = EEventType> = {
  id: string;
  seq: number;
  type: T;
  kind: EEventKind;
  source: string;
  key: string;
  occurredAt: number;
  trace: TBehaviorTraceContext;
  causationId: TOption<string>;
  dedupeKey: TOption<string>;
  payload: TEventPayloads[T];
};
