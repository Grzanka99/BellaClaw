import { createToolDefinition } from "../definition";
import { SDefineMessageImportance } from "./handler";

export const DEFINE_MESSAGE_IMPORTANCE_TOOL = "define-message-importance" as const;

export const defineMessageImportanceTool = createToolDefinition(
  DEFINE_MESSAGE_IMPORTANCE_TOOL,
  "Analyzes a message and assigns an importance level (low, medium, high) based on its content and relevance",
  SDefineMessageImportance,
);
