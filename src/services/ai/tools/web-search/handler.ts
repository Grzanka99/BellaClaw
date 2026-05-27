import z from "zod";

export const SWebSearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});

export type TWebSearchArgs = z.infer<typeof SWebSearchArgs>;

export type TWebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type TWebSearch = {
  query: string;
  results: TWebSearchResult[];
};
