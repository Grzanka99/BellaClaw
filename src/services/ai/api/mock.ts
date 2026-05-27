import type { TOption } from "../../../types";
import { logger } from "../../../utils/logger";
import { MessageHandler } from "../../message-handler";
import { ERole } from "./index";

const EXAMPLE_CHAT_ID = "ai-connector-live-example";
const EXAMPLE_USER_ID = "ai-connector-live-example-user";
const EXAMPLE_USERNAME = "AiConnectorExampleUser";

// This file is a live reference example, not a unit-test mock.
// Running it uses the configured provider, MessageHandler, AiConnector, tool loop,
// memory persistence, and real web tool executors exactly like normal chat handling.
type TExampleCase = {
  id: string;
  prompt: string;
};

export type TExampleResult = {
  caseId: string;
  response: TOption<string>;
};

// Keep cases intentionally broad and Polish-language. The point is to verify that
// normal assistant behavior decides to look up current information without prompts
// directly naming tool implementation details like web-search or web-fetch.
const EXAMPLE_CASES: TExampleCase[] = [
  {
    id: "something-interesting-today",
    prompt: [
      "Czy coś ciekawego dziś się wydarzyło?",
      "Wybierz jedną rzecz, która faktycznie jest aktualna i warta krótkiej uwagi.",
      "Sprawdź źródło, przeczytaj je i odpowiedz po polsku w 2-3 zdaniach z linkiem.",
    ].join("\n"),
  },
  {
    id: "something-interesting-short",
    prompt: "Czy coś ciekawego dziś się wydarzyło?",
  },
  {
    id: "worth-reading",
    prompt: [
      "Podrzuć mi coś wartego przeczytania z dzisiejszych wiadomości ze świata technologii albo nauki.",
      "Nie musi być najważniejsze na świecie, wystarczy że jest świeże i ciekawe.",
      "Najpierw upewnij się w źródle, potem streść mi to krótko po polsku i podaj link.",
    ].join("\n"),
  },
  {
    id: "quick-context",
    prompt: [
      "Mam pięć minut przerwy i chcę szybko wiedzieć, czy dzieje się teraz coś praktycznie ważnego dla programisty.",
      "Wybierz jeden sensowny temat z aktualnych źródeł i sprawdź szczegóły przed odpowiedzią.",
      "Odpowiedz po polsku, konkretnie, bez długiego wstępu, z adresem źródła.",
    ].join("\n"),
  },
  {
    id: "surprise-me",
    prompt: [
      "Zaskocz mnie czymś aktualnym, ale nie losową ciekawostką bez pokrycia.",
      "Znajdź coś, co ma wiarygodne źródło, przeczytaj je i dopiero wtedy wybierz temat.",
      "Napisz po polsku, dlaczego to jest interesujące, i dodaj link.",
    ].join("\n"),
  },
];

export async function runAiConnectorMock(): Promise<TExampleResult[]> {
  const results: TExampleResult[] = [];

  // Use a separate chat id per case so saved memory from one prompt does not
  // dominate the next case. The handler still persists and retrieves normally.
  for (const exampleCase of EXAMPLE_CASES) {
    const chatId = `${EXAMPLE_CHAT_ID}-${exampleCase.id}`;
    const handler = MessageHandler.getInstance(chatId);

    // This is the same incoming-message shape used by production integrations.
    // Do not bypass MessageHandler here: this example should catch regressions in
    // prompt construction, memory lookup, tool instructions, and AiConnector flow.
    const response = await handler.handleMessage({
      chatId,
      message: {
        type: "text",
        content: exampleCase.prompt,
      },
      author: {
        type: ERole.User,
        id: EXAMPLE_USER_ID,
        username: EXAMPLE_USERNAME,
      },
    });

    console.log(response);

    results.push({
      caseId: exampleCase.id,
      response,
    });
  }

  return results;
}

function logExampleResult(result: TExampleResult): void {
  if (result.response === undefined) {
    // Undefined means the production loop did not reach a final assistant reply,
    // commonly because the model kept requesting tools until maxIterations.
    logger.warning(`[AI CONNECTOR MOCK] przypadek ${result.caseId}: brak odpowiedzi koncowej`);
    return;
  }

  // This is the final user-visible response returned by MessageHandler.
  logger.message(`[AI CONNECTOR MOCK] przypadek ${result.caseId}: ${result.response}`);
}

if (import.meta.main) {
  try {
    // Execute with: bun run src/services/ai/api/mock.ts
    // Expected useful signal in logs: provider call -> web lookup/fetch tool calls
    // -> final Polish answer with a source URL for at least some broad cases.
    const results = await runAiConnectorMock();

    for (const result of results) {
      logExampleResult(result);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(`[AI CONNECTOR MOCK] przyklad zakonczony bledem: ${message}`);
    throw error;
  }
}
