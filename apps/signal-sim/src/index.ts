import { ASSISTANT_NUMBER, SIM_ATTACHMENTS_DIR, SIM_PORT, SIM_TRANSCRIPT_DB } from "./config";
import { startSimServer } from "./server";

startSimServer({
  hostname: "127.0.0.1",
  port: SIM_PORT,
  transcriptDb: SIM_TRANSCRIPT_DB,
  attachmentsDir: SIM_ATTACHMENTS_DIR,
  account: ASSISTANT_NUMBER,
});
