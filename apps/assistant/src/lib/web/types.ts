export type TWebContentFormat = "markdown" | "text" | "html";

export type TFetchWebArgs = {
  url: string;
  format?: TWebContentFormat;
  timeout?: number;
};

export type TFetchWebResult = {
  url: string;
  contentType: string;
  format: TWebContentFormat;
  content: string;
  truncated: boolean;
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
