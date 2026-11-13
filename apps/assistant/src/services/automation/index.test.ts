import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { automationDraftsTable, EAutomationStatus, EEventType } from "@bellaclaw/database";
import { eq } from "drizzle-orm";
import { CronScheduler } from "../cron";
import { DatabaseConnector } from "../database";
import {
  resetAutomationsTables,
  resetCronEngineJobsTable,
  resetEventTables,
} from "../database/test-utils";
import { EventBus } from "../events";
import { testEventRequester } from "../events/test-utils";
import {
  AutomationService,
  DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES,
  type TCreateAutomationDraftInput,
} from "./index";
import { EAutomationRunMode, EAutomationRunOutcome } from "./runner";

const db = DatabaseConnector.instance.database;

function draftInput(overrides: Partial<TCreateAutomationDraftInput> = {}) {
  return {
    scope: "discord:1",
    name: "weather",
    source: "export default async () => ({ kind: 'silent' })",
    config: { city: "Warsaw" },
    allowedOrigins: ["https://api.example.com"],
    ...overrides,
  };
}

async function saveAutomation(overrides: Partial<TCreateAutomationDraftInput> = {}) {
  const draft = await AutomationService.instance.createDraft(db, draftInput(overrides));
  return AutomationService.instance.saveDraft(db, draft.scope, draft.id);
}

describe("AutomationService", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
    await resetEventTables();
    Object.assign(EventBus, { _instance: undefined });
    CronScheduler.instance.subscribe();
    AutomationService.instance.setup();
    await EventBus.instance.start();
  });

  afterEach(async () => {
    CronScheduler.instance.destroy();
    await EventBus.instance.idle();
    await EventBus.instance.stop();
  });

  test("createDraft validates and normalizes input", async () => {
    const service = AutomationService.instance;
    const draft = await service.createDraft(
      db,
      draftInput({ name: "  weather  ", allowedOrigins: ["https://API.example.com/v1/path"] }),
    );

    expect(draft.name).toBe("weather");
    expect(draft.allowedOrigins).toEqual(["https://api.example.com"]);
    expect(draft.outputCapBytes).toBe(DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES);
    expect(draft.config).toEqual({ city: "Warsaw" });
    expect(draft.instructions).toBeNull();

    await expect(service.createDraft(db, draftInput({ name: "  " }))).rejects.toThrow("name");
    await expect(
      service.createDraft(db, draftInput({ allowedOrigins: ["ftp://example.com"] })),
    ).rejects.toThrow("ftp://example.com");
    await expect(
      service.createDraft(db, draftInput({ allowedOrigins: ["not a url"] })),
    ).rejects.toThrow("not a url");
    await expect(service.createDraft(db, draftInput({ outputCapBytes: 0 }))).rejects.toThrow(
      "outputCapBytes",
    );
    await expect(service.createDraft(db, draftInput({ outputCapBytes: 262_145 }))).rejects.toThrow(
      "outputCapBytes",
    );
  });

  test("getDraft and saveDraft are scoped", async () => {
    const service = AutomationService.instance;
    const draft = await service.createDraft(db, draftInput());

    expect(await service.getDraft("discord:2", draft.id)).toBeUndefined();
    expect((await service.getDraft("discord:1", draft.id))?.id).toBe(draft.id);
    await expect(service.saveDraft(db, "discord:2", draft.id)).rejects.toThrow("not found");
  });

  test("createDraft drops drafts nobody saved within a day", async () => {
    const service = AutomationService.instance;
    const stale = await service.createDraft(db, draftInput({ name: "stale" }));
    const fresh = await service.createDraft(db, draftInput({ name: "fresh" }));
    await DatabaseConnector.instance.database
      .update(automationDraftsTable)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(automationDraftsTable.id, stale.id));

    await service.createDraft(db, draftInput({ name: "next" }));

    expect(await service.getDraft("discord:1", stale.id)).toBeUndefined();
    expect(await service.getDraft("discord:1", fresh.id)).toBeDefined();
  });

  test("deleteDraft is scoped", async () => {
    const service = AutomationService.instance;
    const draft = await service.createDraft(db, draftInput());

    await service.deleteDraft(db, "discord:2", draft.id);
    expect((await service.getDraft("discord:1", draft.id))?.id).toBe(draft.id);

    await service.deleteDraft(db, "discord:1", draft.id);
    expect(await service.getDraft("discord:1", draft.id)).toBeUndefined();
  });

  test("saveDraft inserts, then updates existing automation keeping state", async () => {
    const service = AutomationService.instance;
    const first = await saveAutomation({ instructions: "Read temp." });

    expect(first.status).toBe(EAutomationStatus.Active);
    expect(first.instructions).toBe("Read temp.");
    expect(first.state).toBeNull();

    await service.recordSuccess(db, first.id, { lastSeen: 5 });
    await service.recordFailure(db, first.id, "boom");

    const pending = await service.createDraft(
      db,
      draftInput({ source: "v2", config: { city: "Oslo" } }),
    );
    const otherDraft = await service.createDraft(db, draftInput({ source: "v3" }));
    const updated = await service.saveDraft(db, "discord:1", pending.id);

    expect(updated.id).toBe(first.id);
    expect(updated.source).toBe("v2");
    expect(updated.config).toEqual({ city: "Oslo" });
    expect(updated.instructions).toBeNull();
    expect(updated.state).toEqual({ lastSeen: 5 });
    expect(updated.failureCount).toBe(0);
    expect(updated.lastError).toBeNull();
    expect(await service.getDraft("discord:1", otherDraft.id)).toBeUndefined();

    const drafts = await DatabaseConnector.instance.database.select().from(automationDraftsTable);
    expect(drafts).toEqual([]);
  });

  test("list, get, and getByIds respect scope and id order", async () => {
    const service = AutomationService.instance;
    const zeta = await saveAutomation({ name: "zeta" });
    const alpha = await saveAutomation({ name: "alpha" });
    const foreign = await saveAutomation({ name: "alpha", scope: "discord:2" });

    expect((await service.list("discord:1")).map((item) => item.name)).toEqual(["alpha", "zeta"]);
    expect((await service.get("discord:2", "alpha"))?.id).toBe(foreign.id);
    expect(await service.get("discord:2", "zeta")).toBeUndefined();

    const byIds = await service.getByIds("discord:1", [zeta.id, 999, foreign.id, alpha.id]);
    expect(byIds.map((item) => item.id)).toEqual([zeta.id, alpha.id]);
    expect(await service.getByIds("discord:1", [])).toEqual([]);
  });

  test("resolveNames returns ids in order and lists unknown names", async () => {
    const service = AutomationService.instance;
    const zeta = await saveAutomation({ name: "zeta" });
    const alpha = await saveAutomation({ name: "alpha" });
    await saveAutomation({ name: "other", scope: "discord:2" });

    expect(await service.resolveNames("discord:1", ["alpha", "zeta"])).toEqual([alpha.id, zeta.id]);
    await expect(service.resolveNames("discord:1", ["alpha", "missing", "other"])).rejects.toThrow(
      "Unknown automations: missing, other",
    );
  });

  test("recordFailure pauses on the third failure and resume resets", async () => {
    const service = AutomationService.instance;
    const automation = await saveAutomation();

    expect(await service.recordFailure(db, automation.id, "e1")).toEqual({
      failureCount: 1,
      paused: false,
    });
    await service.recordSuccess(db, automation.id, undefined);
    expect((await service.get("discord:1", "weather"))?.failureCount).toBe(0);

    await service.recordFailure(db, automation.id, "e1");
    await service.recordFailure(db, automation.id, "e2");
    expect(await service.recordFailure(db, automation.id, "e3")).toEqual({
      failureCount: 3,
      paused: true,
    });
    expect(await service.recordFailure(db, automation.id, "e4")).toEqual({
      failureCount: 4,
      paused: false,
    });

    const paused = await service.get("discord:1", "weather");
    expect(paused?.status).toBe(EAutomationStatus.Paused);
    expect(paused?.lastError).toBe("e4");

    const resumed = await service.setStatus(db, "discord:1", "weather", EAutomationStatus.Active);
    expect(resumed.status).toBe(EAutomationStatus.Active);
    expect(resumed.failureCount).toBe(0);

    await expect(
      service.setStatus(db, "discord:1", "missing", EAutomationStatus.Paused),
    ).rejects.toThrow("not found");
  });

  test("a paused automation's run is Unavailable", async () => {
    const automation = await saveAutomation();
    await AutomationService.instance.setStatus(
      db,
      "discord:1",
      "weather",
      EAutomationStatus.Paused,
    );

    const completed = await testEventRequester.request(
      EEventType.AutomationRunRequested,
      {
        scope: "discord:1",
        automationId: automation.id,
        mode: EAutomationRunMode.Manual,
        timezone: "Europe/Warsaw",
      },
      {
        outcome: EEventType.AutomationRunCompleted,
        step: undefined,
        key: "discord:1",
        timeoutMs: undefined,
      },
    );

    expect(completed.payload.report).toMatchObject({
      outcome: EAutomationRunOutcome.Unavailable,
      error: "automation is paused",
    });
  });

  test("the automation and its drafts are gone", async () => {
    const service = AutomationService.instance;
    await saveAutomation();
    const pendingDraft = await service.createDraft(db, draftInput({ source: "v2" }));

    await testEventRequester.request(
      EEventType.AutomationDeleteRequested,
      { scope: "discord:1", name: "weather" },
      {
        outcome: EEventType.AutomationDeleted,
        step: undefined,
        key: "discord:1",
        timeoutMs: undefined,
      },
    );

    expect(await service.get("discord:1", "weather")).toBeUndefined();
    expect(await service.getDraft("discord:1", pendingDraft.id)).toBeUndefined();
  });
});
