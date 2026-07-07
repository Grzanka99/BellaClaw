export function createMessageTurnId(): string {
  return `msg:${crypto.randomUUID()}`;
}

export function createCronTurnId(): string {
  return `cron:${crypto.randomUUID()}`;
}
