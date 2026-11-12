export function createMessageTurnId(): string {
  return `msg:${crypto.randomUUID()}`;
}

export function createCronTurnId(): string {
  return `cron:${crypto.randomUUID()}`;
}

export function createSystemTurnId(): string {
  return `sys:${crypto.randomUUID()}`;
}
