import { ILinkApiClient } from "./api-client.js";
import { sendTextMessage } from "./media.js";

export async function withTypingIndicator<T>(params: {
  client: ILinkApiClient;
  toUserId: string;
  contextToken: string;
  typingRefreshMs: number;
  thinkingNoticeIntervalMs: number;
  thinkingNoticeScheduleMs?: number[] | undefined;
  shouldSendThinkingNotice?: () => boolean;
  buildThinkingNoticeText: (elapsedSeconds: number) => string;
  work: () => Promise<T>;
}): Promise<T> {
  let typingTicket = "";
  let refreshing = false;
  let refreshTimer: NodeJS.Timeout | undefined;
  let thinkingTimer: NodeJS.Timeout | undefined;
  const scheduledThinkingTimers: NodeJS.Timeout[] = [];
  const thinkingStartedAt = Date.now();
  let sendingThinkingNotice = false;
  let thinkingNoticeQueue = Promise.resolve();

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

  const sendThinkingNotice = (): void => {
    if (sendingThinkingNotice) {
      return;
    }
    if (params.shouldSendThinkingNotice && !params.shouldSendThinkingNotice()) {
      return;
    }

    sendingThinkingNotice = true;
    thinkingNoticeQueue = thinkingNoticeQueue
      .then(async () => {
        await sendTextMessage({
          client: params.client,
          toUserId: params.toUserId,
          contextToken: params.contextToken,
          text: params.buildThinkingNoticeText(
            Math.max(
              1,
              Math.round((Date.now() - thinkingStartedAt) / 1000),
            ),
          ),
        });
      })
      .catch((error) => {
        console.warn("[worker] failed to send thinking notice", error);
      })
      .finally(() => {
        sendingThinkingNotice = false;
      });
  };

  if (params.thinkingNoticeScheduleMs?.length) {
    for (const offsetMs of params.thinkingNoticeScheduleMs) {
      scheduledThinkingTimers.push(
        setTimeout(sendThinkingNotice, offsetMs),
      );
    }
  } else if (params.thinkingNoticeIntervalMs > 0) {
    thinkingTimer = setInterval(
      sendThinkingNotice,
      params.thinkingNoticeIntervalMs,
    );
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
    for (const timer of scheduledThinkingTimers) {
      clearTimeout(timer);
    }

    await thinkingNoticeQueue;

    if (typingTicket) {
      try {
        await sendTypingStatus(2);
      } catch (error) {
        console.warn("[worker] failed to stop typing indicator", error);
      }
    }
  }
}
