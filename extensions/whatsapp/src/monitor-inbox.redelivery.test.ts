// WhatsApp monitor inbox redelivery behavior split by ownership.
import { describe, expect, it, vi } from "vitest";
import { resolveWhatsAppIngressLifecycle } from "./inbound/ingress-lifecycle.js";
import type { WebInboundMessage } from "./inbound/types.js";
import {
  nextMessageId,
  inboundMessage,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox redelivery", () => {
  installStreamsInboundMessageHooks();
  it("delivery coordinator deduplicates redelivered messages by id", async () => {
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("dedupe"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator dispatches same-content messages with distinct ids in order", async () => {
    const onMessage = vi.fn(async (_message: WebInboundMessage) => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    for (const [index, id] of ["in-2", "in-3"].entries()) {
      sock.ev.emit(
        "messages.upsert",
        buildNotifyMessageUpsert({
          id,
          remoteJid: "999@s.whatsapp.net",
          text: "Done.",
          timestamp: 1_700_000_000 + index,
          pushName: "Tester",
        }),
      );
      await waitForMessageCalls(onMessage, index + 1);
    }

    expect(onMessage.mock.calls.map(([message]) => message.event.id)).toEqual(["in-2", "in-3"]);
    await listener.close();
  });

  it("delivery coordinator automatically retries after an explicit retryable failure", async () => {
    let attempts = 0;
    const onMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        // Any non-permanent error is retryable to the drain classifier.
        throw new Error("retry me");
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("retryable-dedupe"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledTimes(1);
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await settleInboundWork();
    // Redelivery of the same message must not re-send the receipt.
    expect(sock.readMessages).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator automatically retries after reply session conflicts", async () => {
    let attempts = 0;
    const onMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "reply session initialization conflicted for agent:main:whatsapp:direct:+15551234567",
        );
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = buildNotifyMessageUpsert({
      id: nextMessageId("session-init-conflict"),
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: 1_700_000_000,
      pushName: "Tester",
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledTimes(1);
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 2);
    await settleInboundWork();
    // Redelivery of the same message must not re-send the receipt.
    expect(sock.readMessages).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator keeps same-lane follow-up pending until turn adoption", async () => {
    let adoptFirst: (() => void | Promise<void>) | undefined;
    const onMessage = vi.fn(async (message: WebInboundMessage) => {
      if (!adoptFirst) {
        const lifecycle = resolveWhatsAppIngressLifecycle(message);
        if (!lifecycle) {
          throw new Error("expected durable ingress lifecycle");
        }
        lifecycle.onDeferred();
        adoptFirst = lifecycle.onAdopted;
      }
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "abc1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "abc2", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "pong" },
          messageTimestamp: 1_700_000_001,
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(inboundMessage(onMessage).payload.body).toBe("ping");

    if (!adoptFirst) {
      throw new Error("expected first adoption callback");
    }
    await adoptFirst();
    await waitForMessageCalls(onMessage, 2);
    expect(inboundMessage(onMessage, 1).payload.body).toBe("pong");
    await listener.close();
  });
});
