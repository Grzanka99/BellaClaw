import { z } from "zod";

// the rejection codes of a connector command: the owner already holds the id, or it is a file
// connector's; the owner holds no stored connector by the id; a resolve of an active connector
export const CONNECTOR_EXISTS = "connector-exists";
export const CONNECTOR_NOT_FOUND = "connector-not-found";
export const CONNECTOR_NOT_PENDING = "connector-not-pending";

// a connector's id, in connectors.json and in the database alike
export const SConnectorId = z.string().regex(/^[a-z][a-z0-9-]*$/);
