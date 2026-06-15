import { z } from "zod";
import type { TOption } from "../../types";
import { createLogger, type TLogger } from "../../utils/logger";

const SSignalSendResponse = z.unknown();
const RECONNECT_DELAY_MS = 5000;

const SSignalReceiveEnvelope = z.object({
  source: z.string().nullable().optional(),
  sourceNumber: z.string().nullable().optional(),
  sourceUuid: z.string().nullable().optional(),
  sourceName: z.string().nullable().optional(),
  profileName: z.string().nullable().optional(),
  timestamp: z.number().optional(),
  dataMessage: z
    .object({
      message: z.string().optional(),
      groupInfo: z.unknown().optional(),
      timestamp: z.number().optional(),
    })
    .optional(),
});

const SSignalReceivePayload = z.object({
  envelope: SSignalReceiveEnvelope.optional(),
});

export type TSignalInboundMessage = {
  sourceNumber: string;
  sourceName: string;
  message: string;
  timestamp: TOption<number>;
};

export type TSignalClientConfig = {
  baseUrl: string;
  phoneNumber: string;
};

function parseJson(raw: string): TOption<unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseSignalReceiveMessage(raw: string): TOption<TSignalInboundMessage> {
  const parsedJson = parseJson(raw);
  if (parsedJson === undefined) {
    return undefined;
  }

  const parsed = SSignalReceivePayload.safeParse(parsedJson);
  if (!parsed.success) {
    return undefined;
  }

  const envelope = parsed.data.envelope;
  if (envelope === undefined) {
    return undefined;
  }

  const dataMessage = envelope.dataMessage;
  if (dataMessage === undefined) {
    return undefined;
  }

  if (dataMessage.groupInfo !== undefined && dataMessage.groupInfo !== null) {
    return undefined;
  }

  const message = dataMessage.message;
  if (message === undefined || message.trim().length === 0) {
    return undefined;
  }

  let sourceNumber = envelope.sourceNumber;
  if (sourceNumber === null || sourceNumber === undefined || sourceNumber.trim().length === 0) {
    sourceNumber = envelope.source;
  }

  if (sourceNumber === null || sourceNumber === undefined || sourceNumber.trim().length === 0) {
    return undefined;
  }

  let sourceName = envelope.sourceName;
  if (sourceName === null || sourceName === undefined || sourceName.trim().length === 0) {
    sourceName = envelope.profileName;
  }
  if (sourceName === null || sourceName === undefined || sourceName.trim().length === 0) {
    sourceName = sourceNumber;
  }

  return {
    sourceNumber,
    sourceName,
    message,
    timestamp: dataMessage.timestamp ?? envelope.timestamp,
  };
}

export class SignalClient {
  private logger: TLogger = createLogger("SIGNAL_CLIENT");
  private baseUrl: URL;
  private phoneNumber: string;

  public constructor(config: TSignalClientConfig) {
    this.baseUrl = new URL(config.baseUrl);
    this.phoneNumber = config.phoneNumber;
  }

  public async checkReadiness(): Promise<boolean> {
    try {
      const response = await fetch(new URL("/v1/about", this.baseUrl));
      if (!response.ok) {
        this.logger.warning(`checkReadiness: /v1/about returned ${response.status}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`checkReadiness: failed to reach signal-cli-rest-api: ${String(error)}`);
      return false;
    }

    return true;
  }

  public async sendText(recipient: string, text: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(new URL("/v2/send", this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          number: this.phoneNumber,
          recipients: [recipient],
        }),
      });
    } catch (error) {
      this.logger.error(`sendText: failed to reach signal-cli-rest-api: ${String(error)}`);
      throw error;
    }

    if (!response.ok) {
      this.logger.error(`sendText: /v2/send returned ${response.status}`);
      throw new Error(`Signal send failed with status ${response.status}`);
    }

    const body = await response.text();
    if (body.trim().length === 0) {
      return;
    }

    const parsedJson = parseJson(body);
    if (parsedJson === undefined) {
      this.logger.warning("sendText: response was not valid JSON");
      return;
    }

    const parsed = SSignalSendResponse.safeParse(parsedJson);
    if (!parsed.success) {
      this.logger.warning("sendText: response did not match expected shape");
    }
  }

  public async showTyping(recipient: string): Promise<void> {
    await this.setTypingIndicator("PUT", recipient, "showTyping");
  }

  public async hideTyping(recipient: string): Promise<void> {
    await this.setTypingIndicator("DELETE", recipient, "hideTyping");
  }

  public async sendReadReceipt(recipient: string, timestamp: number): Promise<void> {
    let response: Response;
    try {
      response = await fetch(new URL(`/v1/receipts/${this.phoneNumber}`, this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          recipient,
          timestamp,
          receipt_type: "read",
        }),
      });
    } catch (error) {
      this.logger.error(`sendReadReceipt: failed to reach signal-cli-rest-api: ${String(error)}`);
      throw error;
    }

    if (!response.ok) {
      this.logger.error(`sendReadReceipt: /v1/receipts returned ${response.status}`);
      throw new Error(`Signal read receipt failed with status ${response.status}`);
    }
  }

  public async subscribe(
    onMessage: (message: TSignalInboundMessage) => void | Promise<void>,
  ): Promise<TOption<() => void>> {
    const receiveUrl = new URL(`/v1/receive/${this.phoneNumber}`, this.baseUrl);
    receiveUrl.searchParams.set("send_read_receipts", "true");
    if (receiveUrl.protocol === "http:") {
      receiveUrl.protocol = "ws:";
    } else if (receiveUrl.protocol === "https:") {
      receiveUrl.protocol = "wss:";
    } else {
      this.logger.error(`subscribe: unsupported protocol ${receiveUrl.protocol}`);
      return undefined;
    }

    let socket: TOption<WebSocket>;
    let reconnectTimer: TOption<ReturnType<typeof setTimeout>>;
    let active = true;

    const connect = () => {
      socket = new WebSocket(receiveUrl);

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          this.handleReceivePayload(event.data, onMessage);
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          this.handleReceivePayload(new TextDecoder().decode(event.data), onMessage);
          return;
        }

        if (event.data instanceof Uint8Array) {
          this.handleReceivePayload(new TextDecoder().decode(event.data), onMessage);
          return;
        }

        if (event.data instanceof Blob) {
          void event.data
            .text()
            .then((raw) => {
              this.handleReceivePayload(raw, onMessage);
            })
            .catch((error) => {
              this.logger.error(`subscribe: failed to read websocket message: ${String(error)}`);
            });
          return;
        }

        this.logger.warning("subscribe: unsupported websocket message data type");
      };

      socket.onerror = () => {
        this.logger.error("subscribe: websocket error");
      };

      socket.onclose = () => {
        this.logger.info("subscribe: websocket closed");
        if (!active) {
          return;
        }

        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };

    connect();

    const initialOpen = await new Promise<boolean>((resolve) => {
      if (socket === undefined) {
        resolve(false);
        return;
      }

      socket.onopen = () => {
        resolve(true);
      };

      socket.onerror = () => {
        this.logger.error("subscribe: websocket error");
        resolve(false);
      };

      socket.onclose = () => {
        this.logger.info("subscribe: websocket closed");
        resolve(false);
      };
    });

    if (!initialOpen) {
      active = false;
      if (socket !== undefined) {
        socket.close();
        socket = undefined;
      }

      return undefined;
    }

    if (socket !== undefined) {
      socket.onerror = () => {
        this.logger.error("subscribe: websocket error");
      };

      socket.onclose = () => {
        this.logger.info("subscribe: websocket closed");
        if (!active) {
          return;
        }

        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    }

    return () => {
      active = false;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }

      if (socket !== undefined) {
        socket.close();
        socket = undefined;
      }
    };
  }

  private async setTypingIndicator(
    method: "PUT" | "DELETE",
    recipient: string,
    operation: string,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(new URL(`/v1/typing-indicator/${this.phoneNumber}`, this.baseUrl), {
        method,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ recipient }),
      });
    } catch (error) {
      this.logger.error(`${operation}: failed to reach signal-cli-rest-api: ${String(error)}`);
      throw error;
    }

    if (!response.ok) {
      this.logger.error(`${operation}: /v1/typing-indicator returned ${response.status}`);
      throw new Error(`Signal typing indicator failed with status ${response.status}`);
    }
  }

  private handleReceivePayload(
    raw: string,
    onMessage: (message: TSignalInboundMessage) => void | Promise<void>,
  ) {
    const message = parseSignalReceiveMessage(raw);
    if (message === undefined) {
      return;
    }

    try {
      const result = onMessage(message);
      void Promise.resolve(result).catch((error) => {
        this.logger.error(`subscribe: message handler failed: ${String(error)}`);
      });
    } catch (error) {
      this.logger.error(`subscribe: message handler failed: ${String(error)}`);
    }
  }
}
