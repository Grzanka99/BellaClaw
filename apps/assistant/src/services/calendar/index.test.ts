import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { adapterFixture, testProvider } from "./fixtures/calendar-adapter";
import { ECalendarProvider } from "./types";

describe("calendar adapter provider routing", () => {
  let fixture: Awaited<ReturnType<typeof adapterFixture>>;
  let google: ReturnType<typeof testProvider>;
  let icloud: ReturnType<typeof testProvider>;
  const create = {
    userId: "chat",
    summary: "Planning",
    start: "2026-07-25T09:00:00Z",
    durationMinutes: 60,
    timezone: "Europe/Warsaw",
  };
  beforeEach(async () => {
    fixture = await adapterFixture();
    google = testProvider(ECalendarProvider.Google);
    icloud = testProvider(ECalendarProvider.ICloud);
    fixture.adapter.registerProvider(google);
    fixture.adapter.registerProvider(icloud);
  });
  afterEach(() => fixture.close());

  test("switching providers directs all writes to the one selected calendar", async () => {
    await fixture.adapter.setWriteCalendar("chat", ECalendarProvider.Google, "google-writer");
    await fixture.adapter.setWriteCalendar(
      "chat",
      ECalendarProvider.ICloud,
      "https://caldav.test/shared/",
    );
    const event = await fixture.adapter.createEvent(create);
    expect(google.createEvent).not.toHaveBeenCalled();
    expect(icloud.createEvent).toHaveBeenCalledWith("https://caldav.test/shared/", create);
    expect(event.id).toBe(
      "icloud:https%3A%2F%2Fcaldav.test%2Fshared%2F:event%3Awith%23punctuation",
    );
    await fixture.adapter.updateEvent({
      userId: "chat",
      eventId: event.id,
      scope: "occurrence",
      patch: { summary: "Changed" },
    });
    expect(icloud.updateEvent.mock.calls[0]?.[1].eventId).toBe("event:with#punctuation");
    await fixture.adapter.deleteEvent({ userId: "chat", eventId: event.id, scope: "series" });
    expect(icloud.deleteEvent.mock.calls[0]?.[1].eventId).toBe("event:with#punctuation");
    expect(google.deleteEvent).not.toHaveBeenCalled();
  });
});
