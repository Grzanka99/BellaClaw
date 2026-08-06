import { randomBytes } from "node:crypto";

console.log(`BELLACLAW_ACTIVATION_TOKEN=${randomBytes(32).toString("base64url")}`);
