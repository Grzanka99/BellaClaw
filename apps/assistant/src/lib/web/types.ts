import type { TOption } from "@bellaclaw/shared";

export type TWebContentFormat = "markdown" | "text" | "html";

export type TFetchWebArgs = {
  url: string;
  format?: TWebContentFormat;
  timeout?: number;
  start?: number;
};

export type TFetchWebResult = {
  url: string;
  contentType: string;
  format: TWebContentFormat;
  // length of the whole formatted page
  totalChars: number;
  // true when the page continues after `content`
  truncated: boolean;
  // the `start` that reads the next part
  nextStart: TOption<number>;
  content: string;
};

export type TWebSearchTopic = "general" | "news" | "finance";

export type TWebSearchTimeRange = "day" | "week" | "month" | "year";

export type TSearchWebArgs = {
  query: string;
  maxResults?: number;
  topic?: TWebSearchTopic;
  timeRange?: TWebSearchTimeRange;
};

export type TWebSearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
};
