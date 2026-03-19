export type TCommonMessage = {
  chatId: string;
  message: string;
  author: "bot" | "user";
};
