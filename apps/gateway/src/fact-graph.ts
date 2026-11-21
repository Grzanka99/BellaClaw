import type { TFactLink, TFactsResponse } from "./api-types";

// NOTE: MAX_FACT_COSINE_DISTANCE of apps/assistant/src/services/memory/index.ts, the cutoff of the
// assistant's memory search
const MAX_FACT_COSINE_DISTANCE = 0.31;
const MAX_NEIGHBOURS = 3;

// createdAt: epoch ms
export type TFact = { id: number; text: string; createdAt: number; embedding: number[] };

function toUnitVector(vector: number[]): number[] {
  const length = Math.hypot(...vector);

  return vector.map((value) => value / length);
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;

  for (let index = 0; index < a.length; index++) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
  }

  return 1 - dot;
}

// Links every fact to its nearest neighbours within the cutoff. Links are undirected, one per pair.
export function buildFactGraph(facts: TFact[]): TFactsResponse {
  const units = facts.map((fact) => ({ id: fact.id, vector: toUnitVector(fact.embedding) }));
  const links = new Map<string, TFactLink>();

  for (const fact of units) {
    const nearest = units
      .filter((other) => other.id !== fact.id)
      .map((other) => ({ id: other.id, distance: cosineDistance(fact.vector, other.vector) }))
      .filter((other) => other.distance <= MAX_FACT_COSINE_DISTANCE)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_NEIGHBOURS);

    for (const neighbour of nearest) {
      const source = Math.min(fact.id, neighbour.id);
      const target = Math.max(fact.id, neighbour.id);
      links.set(`${source}:${target}`, { source, target });
    }
  }

  return {
    nodes: facts.map((fact) => ({ id: fact.id, text: fact.text, createdAt: fact.createdAt })),
    links: [...links.values()],
  };
}
