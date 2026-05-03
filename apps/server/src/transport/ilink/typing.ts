import { ILinkApiClient } from "./api-client.js";
import { sendTextMessage } from "./media.js";

export async function withTypingIndicator<T>(params: {
  client: ILinkApiClient;
  toUserId: string;
  contextToken: string;
  typingRefreshMs: number;
  thinkingNoticeIntervalMs: number;
  shouldSendThinkingNotice?: () => boolean;
  buildThinkingNoticeText: (elapsedSeconds: number) => string;
  work: () => Promise<T>;
}): Promise<T> {
  let typingTicket = "";
  let refreshing = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  let thinkingTimer: NodeJS.Timeout | undefined;
  let thinkingNoticeCount = 0;
  let sendingThinkingNotice = false;

  const sendTypingStatus = async (status: 1 | 2): Promise<void> => {
    if (!typingTicket) {
      return;
    }

    await params.client.sendTyping({
      ilink_user_id: params.toUserId,
      typing_ticket: typingTicket,
      status,
    });
  };

  try {
    const config = await params.client.getConfig(
      params.toUserId,
      params.contextToken,
    );
    typingTicket = config.typing_ticket?.trim() ?? "";

    if (typingTicket) {
      await sendTypingStatus(1);
      if (params.typingRefreshMs > 0) {
        refreshTimer = setInterval(() => {
          if (refreshing) {
            return;
          }

          refreshing = true;
          sendTypingStatus(1)
            .catch((error) => {
              console.warn("[worker] failed to refresh typing indicator", error);
            })
            .finally(() => {
              refreshing = false;
            });
        }, params.typingRefreshMs);
      }
    }
  } catch (error) {
    console.warn("[worker] failed to start typing indicator", error);
  }

  if (params.thinkingNoticeIntervalMs > 0) {
    thinkingTimer = setInterval(() => {
      if (params.shouldSendThinkingNotice && !params.shouldSendThinkingNotice()) {
        return;
      }
      if (sendingThinkingNotice) {
        return;
      }

      thinkingNoticeCount += 1;
      sendingThinkingNotice = true;
      sendTextMessage({
        client: params.client,
        toUserId: params.toUserId,
        contextToken: params.contextToken,
        text: params.buildThinkingNoticeText(
          Math.round(
            (thinkingNoticeCount * params.thinkingNoticeIntervalMs) / 1000,
          ),
        ),
      })
        .catch((error) => {
          console.warn("[worker] failed to send thinking notice", error);
        })
        .finally(() => {
          sendingThinkingNotice = false;
        });
    }, params.thinkingNoticeIntervalMs);
  }

  try {
    return await params.work();
  } finally {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
    }

    if (typingTicket) {
      try {
        await sendTypingStatus(2);
      } catch (error) {
        console.warn("[worker] failed to stop typing indicator", error);
      }
    }
  }
}
