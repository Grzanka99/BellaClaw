# Google Calendar

BellaClaw can modify one calendar and read additional calendars.

Calendar setup is optional. When it is missing or invalid, BellaClaw still starts but calendar tools
remain unavailable.

## Set Up

1. Enable the Google Calendar API in a Google Cloud project.
2. Create a service account and download a JSON key.
3. Create the secrets directory:

   ```bash
   mkdir -p .secrets
   ```

4. Save the key as:

   ```text
   .secrets/google-calendar-service-account.json
   ```

5. Create or choose the calendar BellaClaw may modify.
6. Share it with the service account's `client_email` using **Make changes to events**.
7. Send the calendar ID to BellaClaw as a chat command:

   ```text
   !write-calendar your-calendar-id
   ```

Each chat has its own writable calendar. BellaClaw verifies that the calendar has exact `writer`
access before storing it, and sending the command again replaces the current one.

## Read-Only Calendars

For each extra calendar:

1. Share it with the same service account using **See all event details**.
2. Ask BellaClaw in chat to add its calendar ID.

BellaClaw verifies exact `reader` access before saving it.

## Current Limits

- One global writable calendar
- One global set of read-only calendars
- Calendar configuration is not separated by chat or user
- Event reminders use the writable calendar's defaults

The service-account key stays under `.secrets/`, which Git and the container build context exclude.
