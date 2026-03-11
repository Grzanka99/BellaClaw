const time = (): string => {
  const date = new Date();

  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
};

export const logger = {
  info: (msg: string) => console.log(`${time()} [INFO] ${msg}`),
  warning: (msg: string) => console.log(`${time()} [WARN] ${msg}`),
  error: (msg: string) => console.log(`${time()} [ERRO] ${msg}`),
  message: (msg: string) => console.log(`${time()} [MESG] ${msg}`),
};

export abstract class Logger {
  private prefix = this.constructor.name;

  public constructor(prefix?: string) {
    if (prefix) {
      this.prefix = prefix;
    }
  }

  public logger = {
    info: (msg: string) => logger.info(`[${this.prefix}] ${msg}`),
    warning: (msg: string) => logger.warning(`[${this.prefix}] ${msg}`),
    error: (msg: string) => logger.error(`[${this.prefix}] ${msg}`),
    message: (msg: string) => logger.message(`[${this.prefix}] ${msg}`),
  };
}
