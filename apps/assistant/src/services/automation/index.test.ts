import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ECronJobStatus, type TCronJob, type TCronSchedulerError } from "../../lib/cron-engine";
import { CronSingleton } from "../cron";
import { DatabaseConnector } from "../database";
import { automationDraftsTable, cronEngineJobsTable } from "../database/schema";
import { resetAutomationsTables, resetCronEngineJobsTable } from "../database/test-utils";
import {
  AutomationService,
  DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES,
  EAutomationStatus,
  type TCreateAutomationDraftInput,
} from "./index";

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
  const draft = await AutomationService.instance.createDraft(draftInput(overrides));
  return AutomationService.instance.saveDraft(draft.scope, draft.id);
}

function expectCreated(result: TCronJob | TCronSchedulerError) {
  if ("error" in result) {
    throw new Error(String(result.error));
  }

  return result;
}

describe("AutomationService", () => {
  beforeEach(async () => {
    await resetAutomationsTables();
    await resetCronEngineJobsTable();
  });

  afterEach(() => {
    CronSingleton.instance.destroy();
  });

  test("createDraft validates and normalizes input", async () => {
    const service = AutomationService.instance;
    const draft = await service.createDraft(
      draftInput({ name: "  weather  ", allowedOrigins: ["https://API.example.com/v1/path"] }),
    );

    expect(draft.name).toBe("weather");
    expect(draft.allowedOrigins).toEqual(["https://api.example.com"]);
    expect(draft.outputCapBytes).toBe(DEFAULT_AUTOMATION_OUTPUT_CAP_BYTES);
    expect(draft.config).toEqual({ city: "Warsaw" });
    expect(draft.instructions).toBeUndefined();

    await expect(service.createDraft(draftInput({ name: "  " }))).rejects.toThrow("name");
    await expect(
      service.createDraft(draftInput({ allowedOrigins: ["ftp://example.com"] })),
    ).rejects.toThrow("ftp://example.com");
    await expect(
      service.createDraft(draftInput({ allowedOrigins: ["not a url"] })),
    ).rejects.toThrow("not a url");
    await expect(service.createDraft(draftInput({ outputCapBytes: 0 }))).rejects.toThrow(
      "outputCapBytes",
    );
    await expect(service.createDraft(draftInput({ outputCapBytes: 262_145 }))).rejects.toThrow(
      "outputCapBytes",
    );
    await expect(service.createDraft(draftInput({ config: { n: 1n } }))).rejects.toThrow(
      "JSON-serializable",
    );
  });

  test("getDraft and saveDraft are scoped", async () => {
    const service = AutomationService.instance;
    const draft = await service.createDraft(draftInput());

    expect(await service.getDraft("discord:2", draft.id)).toBeUndefined();
    expect((await service.getDraft("discord:1", draft.id))?.id).toBe(draft.id);
    await expect(service.saveDraft("discord:2", draft.id)).rejects.toThrow("not found");
  });

  test("saveDraft inserts, then updates existing automation keeping state", async () => {
    const service = AutomationService.instance;
    const first = await saveAutomation({ instructions: "Read temp." });

    expect(first.status).toBe(EAutomationStatus.Active);
    expect(first.instructions).toBe("Read temp.");
    expect(first.state).toBeUndefined();

    await service.recordSuccess(first.id, { lastSeen: 5 });
    await service.recordFailure(first.id, "boom");

    const pending = await service.createDraft(
      draftInput({ source: "v2", config: { city: "Oslo" } }),
    );
    const otherDraft = await service.createDraft(draftInput({ source: "v3" }));
    const updated = await service.saveDraft("discord:1", pending.id);

    expect(updated.id).toBe(first.id);
    expect(updated.source).toBe("v2");
    expect(updated.config).toEqual({ city: "Oslo" });
    expect(updated.instructions).toBeUndefined();
    expect(updated.state).toEqual({ lastSeen: 5 });
    expect(updated.failureCount).toBe(0);
    expect(updated.lastError).toBeUndefined();
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

    expect(await service.recordFailure(automation.id, "e1")).toEqual({
      failureCount: 1,
      paused: false,
    });
    await service.recordSuccess(automation.id, undefined);
    expect((await service.get("discord:1", "weather"))?.failureCount).toBe(0);

    await service.recordFailure(automation.id, "e1");
    await service.recordFailure(automation.id, "e2");
    expect(await service.recordFailure(automation.id, "e3")).toEqual({
      failureCount: 3,
      paused: true,
    });
    expect(await service.recordFailure(automation.id, "e4")).toEqual({
      failureCount: 4,
      paused: false,
    });

    const paused = await service.get("discord:1", "weather");
    expect(paused?.status).toBe(EAutomationStatus.Paused);
    expect(paused?.lastError).toBe("e4");

    const resumed = await service.setStatus("discord:1", "weather", EAutomationStatus.Active);
    expect(resumed.status).toBe(EAutomationStatus.Active);
    expect(resumed.failureCount).toBe(0);

    await expect(
      service.setStatus("discord:1", "missing", EAutomationStatus.Paused),
    ).rejects.toThrow("not found");
  });

  test("delete removes automation, drafts, and its id from cron jobs", async () => {
    const service = AutomationService.instance;
    const automation = await saveAutomation();
    const keep = await saveAutomation({ name: "keep" });
    const pendingDraft = await service.createDraft(draftInput({ source: "v2" }));

    const rawOnly = expectCreated(
      await CronSingleton.instance.createRecurring({
        name: "raw-only",
        scope: "discord:1",
        pattern: "0 8 * * *",
        automationIds: [automation.id],
      }),
    );
    const mixed = expectCreated(
      await CronSingleton.instance.createRecurring({
        name: "mixed",
        scope: "discord:1",
        pattern: "0 8 * * *",
        automationIds: [automation.id, keep.id],
      }),
    );

    const result = await service.delete("discord:1", "weather");

    expect(result.automation.id).toBe(automation.id);
    expect(result.cancelledJobs).toEqual(["raw-only"]);
    expect(result.updatedJobs).toEqual(["mixed"]);
    expect(await service.get("discord:1", "weather")).toBeUndefined();
    expect(await service.getDraft("discord:1", pendingDraft.id)).toBeUndefined();

    const db = DatabaseConnector.instance.database;
    const rawRow = await db
      .select()
      .from(cronEngineJobsTable)
      .where(eq(cronEngineJobsTable.id, rawOnly.id))
      .get();
    expect(rawRow?.status).toBe(ECronJobStatus.Cancelled);
    expect((await CronSingleton.instance.get("mixed", "discord:1"))?.automationIds).toEqual([
      keep.id,
    ]);
    expect(mixed.automationIds).toEqual([automation.id, keep.id]);

    await expect(service.delete("discord:1", "weather")).rejects.toThrow("not found");
  });
});
