import type { TEvent } from "../server/control-schema";

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

export function formatEvent(event: TEvent): string {
  let direction = "IN ";
  if (event.direction === "out") {
    direction = "OUT";
  }

  let body = (event.text ?? "").replaceAll("\n", " ⏎ ");
  if (event.kind === "typing") {
    body = `(typing ${event.text})`;
  } else if (event.kind === "receipt") {
    body = `(${event.text} receipt for ${event.signalTimestamp})`;
  } else if (event.kind === "noise") {
    body = `(${event.text})`;
  }

  const parts = [clock(event.at), direction, event.chat, body];
  if (event.attachments.length > 0) {
    const names = event.attachments.map((attachment) => attachment.filename ?? attachment.id);
    parts.push(`[${names.join(", ")}]`);
  }

  return parts.filter((part) => part.length > 0).join(" ");
}
