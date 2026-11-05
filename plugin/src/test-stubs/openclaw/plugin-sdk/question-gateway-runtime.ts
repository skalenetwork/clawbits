// Test stand-in for the host's ask_user runtime. `readAskUserQuestionId` mirrors core; tests
// replace `resolveOption` and `registerChannelDelivery` to drive a question's outcome.

type Finalize = (statusLine: string) => void | Promise<void>;

export const questionGatewayRuntime = {
  readAskUserQuestionId(payload: { channelData?: Record<string, unknown> }): string | undefined {
    const askUser = payload.channelData?.["askUser"];
    if (!askUser || typeof askUser !== "object") return undefined;
    const questionId = (askUser as { questionId?: unknown }).questionId;
    return typeof questionId === "string" && questionId ? questionId : undefined;
  },
  async resolveOption(_params: {
    questionId: string;
    optionValue: string;
    senderId?: string;
    authorize?: () => boolean | Promise<boolean>;
  }): Promise<{ status: string }> {
    return { status: "already-terminal" };
  },
  registerChannelDelivery(_params: { questionId: string; deliveryId: string; finalize: Finalize }): void {},
};
