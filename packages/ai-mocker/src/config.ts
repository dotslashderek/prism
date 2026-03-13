/** Configuration type for the AI mocker. */
export type AiMockerConfig = {
  readonly ai: boolean;
};

/** Default configuration — AI mocking disabled. */
export const defaultAiMockerConfig: AiMockerConfig = {
  ai: false,
};
