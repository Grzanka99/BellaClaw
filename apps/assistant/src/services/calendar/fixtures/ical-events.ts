export function calendarData(master: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calendar tests//EN",
    "X-WR-TIMEZONE:Europe/Warsaw",
    "BEGIN:VEVENT",
    "UID:weekly@example.test",
    "DTSTAMP:20260101T000000Z",
    ...master,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export const weekly = [
  "DTSTART;TZID=Europe/Warsaw:20260322T090000",
  "DTEND;TZID=Europe/Warsaw:20260322T100000",
  "RRULE:FREQ=WEEKLY;COUNT=5",
  "SUMMARY:Weekly planning",
];

export const marchApril = {
  userId: "chat-test",
  timeMin: "2026-03-01T00:00:00Z",
  timeMax: "2026-05-01T00:00:00Z",
  timezone: "Europe/Warsaw",
};
