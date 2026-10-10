# iCloud Calendar

BellaClaw supports Google and iCloud through the app-facing `CalendarAdapter`. Providers register
with `registerProvider()`, like transports register with `MessagingAdapter`.

Each chat reads any number of configured calendars and has **one writable calendar total**.
The writable calendar may be Google or iCloud. Setting another one replaces the previous one.

## Dedicated Apple Account

1. Create an Apple Account for BellaClaw and enable two-factor authentication.
2. Enable iCloud Calendar for that account and confirm Calendar works when signed in to iCloud.com.
   A web-only account may not include Calendar; set up iCloud on an Apple device if needed.
3. From your personal account, privately share the calendars BellaClaw needs with its account.
   Enable **Allow editing** for the calendar it will write to. Other calendars can be read-only.
4. Sign in as BellaClaw and accept the calendar invitations.
5. At [account.apple.com](https://account.apple.com), open **Sign-In and Security → App-Specific
   Passwords** and generate one named **BellaClaw**. This is a separate generated password, not
   the account's main password.
6. Store the account identifier and generated password in `.secrets/icloud-calendar.json`:

   ```json
   {
     "username": "bellaclaw@example.com",
     "appSpecificPassword": "generated-password"
   }
   ```

The `.secrets/` directory is ignored by Git and mounted into the assistant container. Restart the
assistant after changing credentials. Changing the main Apple password revokes app-specific
passwords; generate a replacement when that happens.

[Apple calendar sharing](https://support.apple.com/guide/icloud/share-a-calendar-mm6b1a9479/icloud)
and [app-specific passwords](https://support.apple.com/en-us/102654).

## Calendar Setup

Discover the account's calendars and copy the exact `calendarId` URL from the response:

```text
!calendar_discover icloud
```

Configure the writable calendar:

```text
!calendar_add-write icloud CALENDAR_URL
```

Add extra calendars as read-only:

```text
!calendar_add-read icloud CALENDAR_URL
```

Ask BellaClaw to list or remove configured read-only calendars. The calendar tools return the
provider and calendar ID. Event IDs are opaque references: use the exact ID returned by listing
events, rather than constructing one. Events on read-only calendars cannot be edited or deleted.

## Event Changes

- Create, list, update, and delete timed or all-day events.
- Events without an explicit timezone use the calendar's timezone, then the event file's timezone,
  then UTC. Listing and editing use the same timezone.
- Update or delete one recurring occurrence, the whole series, or this and following occurrences.
- Existing alarms and properties BellaClaw does not manage are retained when editing resources.
- Conditional updates and deletes reject conflicts with simultaneous iPhone edits. List events
  again before retrying a conflict.
- Following updates split the series. If successor creation fails, BellaClaw verifies whether it
  exists before attempting to restore the original using its latest ETag.
- Unsafe recurrence edits fail before writing: following splits with invitations, attachments,
  conferencing, `THISANDFUTURE` overrides, or extra recurrence dates before the series start;
  changes to series times or rules with modified or deleted occurrences; and single-occurrence
  edits at a `THISANDFUTURE` boundary.
- Invitations to single occurrences of a series kept in another calendar are listed and count
  for availability, but cannot be updated or deleted.
- Creating or rescheduling a start in the first instance of an autumn repeated hour is rejected
  if it cannot survive a timezone roundtrip. Use an explicit UTC start and `UTC` timezone instead.

Missing credentials disable only that provider; Google and iCloud can be used independently.
Existing Google calendar records migrate with `provider = google`, keeping their access and IDs.
Apply database migrations with `bun run db migrate` before starting the updated assistant.

Protocol tests run without an Apple account. A live check still requires a calendar shared with
the dedicated account: discover it, create an event, edit it, and delete it. Use a temporary calendar
for that check.
