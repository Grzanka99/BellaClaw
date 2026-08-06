import { type Static, StringEnum, Type } from "@earendil-works/pi-ai";
import { EMemoryImportance, type TMemory } from "../../../memory/types";

export const SSearchMemoryArgs = Type.Object(
  {
    searchString: Type.Optional(
      Type.String({
        description: "Partial text to search for anywhere within stored message content",
      }),
    ),
    timeRange: Type.Optional(
      Type.Object(
        {
          start: Type.String({
            format: "date-time",
            description: "Inclusive ISO 8601 start date-time",
          }),
          end: Type.String({
            format: "date-time",
            description: "Inclusive ISO 8601 end date-time",
          }),
        },
        {
          additionalProperties: false,
          description: "Filter memories created within this time range",
        },
      ),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, description: "Maximum number of memories to return" }),
    ),
    importance: Type.Optional(
      Type.Array(StringEnum(Object.values(EMemoryImportance)), {
        description: "Importance levels to include: low, medium, or high",
      }),
    ),
  },
  { additionalProperties: false },
);

export type TSearchMemoryArgs = Static<typeof SSearchMemoryArgs>;

export type TSearchMemory = {
  memories: TMemory[];
};

type TConvertedSearchMemoryArgs = Omit<TSearchMemoryArgs, "timeRange"> & {
  timeRange?: {
    start: Date;
    end: Date;
  };
};

export function convertSearchMemoryArgs(args: TSearchMemoryArgs): TConvertedSearchMemoryArgs {
  const { timeRange, ...rest } = args;

  if (timeRange === undefined) {
    return rest;
  }

  return {
    ...rest,
    timeRange: {
      start: new Date(timeRange.start),
      end: new Date(timeRange.end),
    },
  };
}
