export type BoomError = {
  output?: {
    statusCode?: number;
    payload?: {
      message?: string;
    };
  };
};
