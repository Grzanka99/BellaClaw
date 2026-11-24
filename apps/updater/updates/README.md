# Update Scripts

One script per deployment change a database migration cannot make, such as renaming a key in
`.env` or removing an old container.

- Name: `NNNN-what-it-does.ts`, e.g. `0001-rename-signal-key.ts`.
- Runs once per server, in name order, in the update runner after the assistant stopped and before
  the database migrations. The working directory is the repository checkout, and Podman is
  reachable with `podman` and `podman-compose`.
- Exit 0 means done: the name is recorded in `applied-updates` and the script never runs again.
  Any other exit restores the old version and sends the end of the output to the chat.
- Must be safe to run twice: a script that failed halfway runs again with the next update.
- Must cope with nothing to change, e.g. a server that never had the old key.
