// NOTE: shapes follow signal-cli's org.asamk.signal.json records (JsonMessageEnvelope,
// JsonDataMessage, JsonAttachment, ...). Jackson writes null for fields without NON_NULL, so
// those keys are always present; NON_NULL fields are omitted when absent.

import type { TOption } from "@bellaclaw/shared";

export type TEnvelopeAttachment = {
  contentType: string;
  filename: TOption<string>;
  id: string;
  size: number;
  isVoiceNote: boolean;
  uploadTimestamp: number;
};

export type TReceivePayload = {
  envelope: Record<string, unknown>;
  account: string;
};

export function uuidForNumber(number: string): string {
  const hex = new Bun.CryptoHasher("sha1").update(number).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function envelopeBase(source: string, sourceDevice: number, timestamp: number) {
  return {
    source,
    sourceNumber: source,
    sourceUuid: uuidForNumber(source),
    sourceName: null,
    sourceDevice,
    timestamp,
    serverReceivedTimestamp: timestamp + 40,
    serverDeliveredTimestamp: Date.now(),
  };
}

function dataMessage(timestamp: number, message: TOption<string>) {
  return {
    timestamp,
    message: message ?? null,
    expiresInSeconds: 0,
    isExpirationUpdate: false,
    viewOnce: false,
    isEndSession: false,
    isProfileKeyUpdate: false,
    hasProfileKey: true,
  };
}

function attachmentJson(attachment: TEnvelopeAttachment) {
  return {
    contentType: attachment.contentType,
    filename: attachment.filename ?? null,
    id: attachment.id,
    size: attachment.size,
    width: null,
    height: null,
    caption: null,
    uploadTimestamp: attachment.uploadTimestamp,
    isVoiceNote: attachment.isVoiceNote,
  };
}

export function directMessageEnvelope(
  source: string,
  timestamp: number,
  text: TOption<string>,
  attachments: TEnvelopeAttachment[],
): Record<string, unknown> {
  const data: Record<string, unknown> = dataMessage(timestamp, text);
  if (attachments.length > 0) {
    data.attachments = attachments.map(attachmentJson);
  }

  return { ...envelopeBase(source, 1, timestamp), dataMessage: data };
}

export function groupMessageEnvelope(
  source: string,
  timestamp: number,
  groupId: string,
  text: string,
): Record<string, unknown> {
  return {
    ...envelopeBase(source, 1, timestamp),
    dataMessage: {
      ...dataMessage(timestamp, text),
      groupInfo: { groupId, groupName: "Sim group", revision: 1, type: "DELIVER" },
    },
  };
}

export function receiptEnvelope(
  source: string,
  timestamp: number,
  acknowledged: number[],
): Record<string, unknown> {
  return {
    ...envelopeBase(source, 1, timestamp),
    receiptMessage: {
      when: timestamp,
      isDelivery: true,
      isRead: false,
      isViewed: false,
      timestamps: acknowledged,
    },
  };
}

export function typingEnvelope(source: string, timestamp: number): Record<string, unknown> {
  return {
    ...envelopeBase(source, 1, timestamp),
    typingMessage: { action: "STARTED", timestamp },
  };
}

// NOTE: a sync transcript comes from the account's own linked device (device 2) and describes a
// message that device sent to `destination`.
export function syncSentEnvelope(
  account: string,
  destination: string,
  timestamp: number,
  text: string,
): Record<string, unknown> {
  return {
    ...envelopeBase(account, 2, timestamp),
    syncMessage: {
      sentMessage: {
        destination,
        destinationNumber: destination,
        destinationUuid: uuidForNumber(destination),
        ...dataMessage(timestamp, text),
      },
    },
  };
}
