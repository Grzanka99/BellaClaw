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

export type TSearchWebArgs = {
  query: string;
  limit?: number;
};

export type TWebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};
