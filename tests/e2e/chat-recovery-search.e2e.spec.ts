import { test, expect, type Page } from "@playwright/test";
import { setup, login } from "./helpers/chat";

test.setTimeout(90000);
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("[browser]", error.message));
});
const pendingCount = (page: Page, userId: number, room: string) =>
  page.evaluate(
    async ({ userId, room }) => {
      const path = "/src/utils/pending-messages.ts";
      const module = await import(path);
      return (await module.listPendingMessages(userId, room)).length;
    },
    { userId, room },
  );

test("lost ACK survives refresh, offline messages recover once, search locates older history", async ({
  page,
  context,
}) => {
  const { api, a, b, room } = await setup();
  let hideSaved = true;
  await page.routeWebSocket("**/message/connect_chat?**", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (
        hideSaved &&
        (frame.name === "ack" || frame.content === "ack-lost-refresh")
      )
        return;
      socket.send(raw);
    });
  });
  await page.route("**/assistant/agent", (route) =>
    route.fulfill({ json: { code: 200, data: { content: "回复建议", replySuggestions: [] } } }),
  );
  await login(page, a, room);
  a.token = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("pomelo-chat.authToken") || '""'),
  );
  const input = page.getByLabel("消息输入框");
  await input.fill("ack-lost-refresh");
  await input.press("Enter");
  await expect.poll(() => pendingCount(page, a.info.id, room)).toBe(1);
  await expect
    .poll(async () => {
      const response = await api.get("message/search", {
        headers: { Authorization: `Bearer ${a.token}` },
        params: { room, type: "private", query: "ack-lost-refresh" },
      });
      return (await response.json()).data.messages.length;
    })
    .toBe(1);
  hideSaved = false;
  await page.reload();
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect.poll(() => pendingCount(page, a.info.id, room)).toBe(0);
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("ack-lost-refresh", { exact: true }),
  ).toHaveCount(1);

  await context.setOffline(true);
  await input.fill("offline-refresh");
  await input.press("Enter");
  await expect.poll(() => pendingCount(page, a.info.id, room)).toBe(1);
  await context.setOffline(false);
  await page.reload();
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect
    .poll(() => pendingCount(page, a.info.id, room), { timeout: 20000 })
    .toBe(0);
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("offline-refresh", { exact: true }),
  ).toHaveCount(1);

  // A second tab shares IndexedDB and the same login without replacing the token.
  const session = await page.evaluate(() =>
    Object.fromEntries(Object.entries(sessionStorage)),
  );
  const second = await context.newPage();
  await second.goto("/login");
  await second.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries))
      sessionStorage.setItem(key, value);
  }, session);
  await page.evaluate(
    async ({ room, user, peerId }) => {
      const path = "/src/utils/pending-messages.ts";
      const queue = await import(path);
      const id = "multi_tab_restore_001";
      await queue.savePendingMessage({
        key: queue.pendingKey(user.info.id, room, id),
        userId: user.info.id,
        room,
        chatType: "private",
        createdAt: Date.now(),
        message: {
          clientMsgId: id,
          content: "multi-tab-restored",
          type: "text",
          sender_id: user.info.id,
          receiver_id: peerId,
          avatar: "",
        },
      });
    },
    { room, user: a, peerId: b.info.id },
  );
  await second.goto(page.url());
  await second.locator(`[id="chatList_${room}"]`).click();
  await expect
    .poll(() => pendingCount(page, a.info.id, room), { timeout: 20000 })
    .toBe(0);
  await expect
    .poll(async () => {
      const result = await api.get("message/search", {
        headers: { Authorization: `Bearer ${a.token}` },
        params: { room, type: "private", query: "multi-tab-restored" },
      });
      return (await result.json()).data.messages.length;
    })
    .toBe(1);
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("multi-tab-restored", { exact: true }),
  ).toHaveCount(1);
  await expect(
    second
      .locator("[data-message-index]")
      .getByText("multi-tab-restored", { exact: true }),
  ).toHaveCount(1);
  await second.close();

  // Populate real history beyond the initial page through the peer's socket.
  await page.evaluate(
    async ({ room, user }) => {
      const { wsBaseURL: testWsBaseURL, apiBaseURL: testBrowserApiURL } = await import("/src/config/index.ts");

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `${testWsBaseURL}/message/connect_chat?room=${encodeURIComponent(room)}&id=${user.info.id}&type=private`,
          ["pomelo-token", user.token],
        );
        let index = 0;
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("seed timeout"));
        }, 20000);
        const send = () =>
          ws.send(
            JSON.stringify({
              content: `seed-${index}`,
              type: "text",
              clientMsgId: `seed_${Date.now()}_${index}`,
            }),
          );
        ws.onmessage = (event) => {
          const frame = JSON.parse(event.data);
          if (frame.name === "history") send();
          if (frame.name === "ack") {
            index++;
            if (index < 65) send();
            else {
              clearTimeout(timeout);
              ws.close();
              resolve();
            }
          }
        };
        ws.onerror = () => reject(new Error("seed socket error"));
      });
    },
    { room, user: b },
  );
  await page.reload();
  await page.locator(`[id="chatList_${room}"]`).click();
  await page.getByRole("button", { name: "搜索聊天记录", exact: true }).click();
  let readReports = 0;
  page.on("request", (request) => {
    if (request.url().includes("/message/read")) readReports++;
  });
  const search = page.getByRole("complementary", { name: "聊天记录搜索" });
  await search.getByLabel("聊天记录关键词").fill("ack-lost-refresh");
  await search.getByRole("button", { name: "搜索", exact: true }).click();
  await search.getByRole("button", { name: /ack-lost-refresh/ }).click();
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("ack-lost-refresh", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "返回最新消息", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加载较新消息", exact: true }).click();
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("ack-lost-refresh", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(700); // Beyond the 300 ms read-receipt debounce.
  expect(readReports).toBe(0);
  await page.getByRole("button", { name: "返回最新消息", exact: true }).click();
  await search.getByRole("button", { name: "关闭搜索" }).click();
  await expect(
    page.locator("[data-message-index]").getByText("seed-64", { exact: true }),
  ).toBeVisible();
  await api.dispose();
});

test("IndexedDB leases, queue limits, expiry, cancellation and account isolation", async ({
  page,
}) => {
  await page.goto("/login");
  const result = await page.evaluate(async () => {
    const path = "/src/utils/pending-messages.ts";
    const module = await import(path);
    const userId = 880001,
      room = "queue-test";
    await module.clearPendingMessages(userId);
    const row = (id: string, createdAt = Date.now()) => ({
      key: module.pendingKey(userId, room, id),
      userId,
      room,
      chatType: "private",
      message: {
        clientMsgId: id,
        content: "queued",
        sender_id: userId,
        receiver_id: 2,
        avatar: "",
        type: "text",
      },
      createdAt,
    });
    await module.savePendingMessage(row("lease_test_key"));
    const claims = await Promise.all([
      module.claimPendingMessage(row("lease_test_key").key, "tab-a"),
      module.claimPendingMessage(row("lease_test_key").key, "tab-b"),
    ]);
    const leaseWinners = claims.filter(Boolean).length;
    await module.savePendingMessage(
      row("old_test_key", Date.now() - 2 * 86400000),
    );
    const oldAutomatic = Boolean(
      await module.claimPendingMessage(row("old_test_key").key, "auto"),
    );
    const oldManual = Boolean(
      await module.claimPendingMessage(row("old_test_key").key, "manual", true),
    );
    await module.removePendingMessage(row("lease_test_key").key);
    const cancelled = Boolean(
      await module.claimPendingMessage(
        row("lease_test_key").key,
        "after-cancel",
      ),
    );
    const foreignCount = (await module.listPendingMessages(880002)).length;
    await module.clearPendingMessages(userId);
    for (let i = 0; i < 100; i++)
      await module.savePendingMessage(row(`capacity_${i}`));
    const overCapacity = await module.savePendingMessage(row("overflow_key"));
    const count = (await module.listPendingMessages(userId)).length;
    await module.clearPendingMessages(userId);
    await module.savePendingMessage(
      row("expired_key", Date.now() - 8 * 86400000),
    );
    const expiredCount = (await module.listPendingMessages(userId)).length;
    return {
      leaseWinners,
      oldAutomatic,
      oldManual,
      cancelled,
      foreignCount,
      overCapacity,
      count,
      expiredCount,
    };
  });
  expect(result).toEqual({
    leaseWinners: 1,
    oldAutomatic: false,
    oldManual: true,
    cancelled: false,
    foreignCount: 0,
    overCapacity: false,
    count: 100,
    expiredCount: 0,
  });
});

test("storage failure keeps page sending available and late failure cannot overwrite ACK", async ({
  page,
}) => {
  const { api, a, room } = await setup();
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await page.routeWebSocket("**/message/connect_chat?**", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      socket.send(raw);
      const frame = JSON.parse(String(raw));
      if (frame.name === "ack")
        socket.send(
          JSON.stringify({
            name: "error",
            client_msg_id: frame.client_msg_id,
            message: "late failure",
          }),
        );
    });
  });
  await login(page, a, room);
  const input = page.getByLabel("消息输入框");
  await input.fill("storage-fallback-sent");
  await input.press("Enter");
  await expect(page.getByText(/无法保存待发送消息/)).toBeVisible();
  const message = page
    .locator("[data-message-index]")
    .filter({ hasText: "storage-fallback-sent" });
  await expect(message).toHaveCount(1);
  await expect(message.getByRole("button", { name: /重试/ })).toHaveCount(0);
  a.token = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("pomelo-chat.authToken") || '""'),
  );
  const result = await api.get("message/search", {
    headers: { Authorization: `Bearer ${a.token}` },
    params: { room, type: "private", query: "storage-fallback-sent" },
  });
  expect((await result.json()).data.messages).toHaveLength(1);
  await api.dispose();
});

test("switching conversations isolates delayed history, assistant streams and task candidates", async ({
  page,
}) => {
  const { api, a, b, room, create } = await setup();
  const c = await create(3);
  await api.post("friend/add_friend", {
    headers: { Authorization: `Bearer ${a.token}` },
    data: { id: c.info.id, username: c.username },
  });
  const chats = (
    await (
      await api.get("message/chat_list", {
        headers: { Authorization: `Bearer ${a.token}` },
      })
    ).json()
  ).data;
  const otherRoom = chats.find(
    (item: { room: string }) => item.room !== room,
  ).room;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/login");
  await page.evaluate(
    async ({ room, token, id }) => {
      const { wsBaseURL: testWsBaseURL, apiBaseURL: testBrowserApiURL } = await import("/src/config/index.ts");

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(
          `${testWsBaseURL}/message/connect_chat?room=${encodeURIComponent(room)}&id=${id}&type=private`,
          ["pomelo-token", token],
        );
        let index = 0;
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("history seed timeout"));
        }, 15000);
        const send = () =>
          ws.send(
            JSON.stringify({
              content: `isolation-history-${index}`,
              type: "text",
              clientMsgId: `isolate_${Date.now()}_${index}`,
            }),
          );
        ws.onmessage = (event) => {
          const frame = JSON.parse(event.data);
          if (frame.name === "history") send();
          if (frame.name === "ack") {
            if (++index < 35) send();
            else {
              clearTimeout(timeout);
              ws.close();
              resolve();
            }
          }
        };
        ws.onerror = () => reject(new Error("seed failed"));
      });
    },
    { room, token: b.token, id: b.info.id },
  );
  await login(page, a, room);
  let releaseHistory!: () => void;
  const delayedHistory = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  let historyStarted = false;
  await page.route("**/message/history?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("room") !== room ||
      !url.searchParams.has("beforeId")
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    historyStarted = true;
    await delayedHistory;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await expect.poll(() => historyStarted).toBe(true);
  await page.locator(`[id="chatList_${otherRoom}"]`).click();
  releaseHistory();
  const input = page.getByLabel("消息输入框");
  await input.fill("other-room-message");
  await input.press("Enter");
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("other-room-message", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("[data-message-index]")
      .filter({ hasText: "isolation-history-" }),
  ).toHaveCount(0);
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect(
    page.getByRole("button", { name: "加载更早消息", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "加载更早消息", exact: true }),
  ).toHaveCount(0);

  let releaseStream!: () => void;
  const streamWait = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  let streamStarted = false;
  await page.route("**/assistant/agent/stream", async (route) => {
    streamStarted = true;
    await streamWait;
    await route
      .fulfill({
        contentType: "text/event-stream",
        body: 'event: result\ndata: {"content":"obsolete-assistant-result","actions":[]}\n\n',
      })
      .catch(() => undefined);
  });
  await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
  await input.fill("assistant-request-before-switch");
  await input.press("Enter");
  await expect.poll(() => streamStarted).toBe(true);
  await page.locator(`[id="chatList_${otherRoom}"]`).click();
  releaseStream();
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("other-room-message", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("obsolete-assistant-result", { exact: true }),
  ).toHaveCount(0);
  await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("assistant-request-before-switch", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .locator("[data-message-index]")
      .getByText("other-room-message", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("obsolete-assistant-result", { exact: true }),
  ).toHaveCount(0);

  let releaseTasks!: () => void;
  const taskWait = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });
  let taskStarted = false;
  await page.route("**/assistant/agent/task-candidates", async (route) => {
    const stale = route.request().postDataJSON().room === room;
    if (stale) {
      taskStarted = true;
      await taskWait;
    }
    await route
      .fulfill({
        json: {
          code: 200,
          data: {
            todos: [
              { title: stale ? "obsolete-task" : "current-task", sources: [] },
            ],
            action: null,
          },
        },
      })
      .catch(() => undefined);
  });
  await page.getByRole("button", { name: "打开 Copilot", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "AI Copilot 助手面板",
  });
  await panel.getByRole("tab", { name: "待办", exact: true }).click();
  await panel.getByLabel("选择聊天会话").selectOption(room);
  await panel.getByRole("button", { name: "整理事项" }).click();
  await expect.poll(() => taskStarted).toBe(true);
  await panel.getByLabel("选择聊天会话").selectOption(otherRoom);
  await panel.getByRole("button", { name: "整理事项" }).click();
  await expect(panel.getByText("current-task", { exact: true })).toBeVisible();
  releaseTasks();
  await page.waitForTimeout(300);
  await expect(panel.getByText("obsolete-task", { exact: true })).toHaveCount(
    0,
  );
  await expect(panel.getByText("current-task", { exact: true })).toBeVisible();
  let releaseMemory!: () => void;
  const memoryWait = new Promise<void>((resolve) => {
    releaseMemory = resolve;
  });
  let memoryStarted = false;
  await page.route("**/assistant/agent/tools/call", async (route) => {
    memoryStarted = true;
    await memoryWait;
    await route
      .fulfill({
        json: {
          code: 200,
          data: {
            name: "search_memory",
            result: { memories: [{ id: 1, content: "obsolete-memory" }] },
          },
        },
      })
      .catch(() => undefined);
  });
  await panel.getByRole("tab", { name: "记忆", exact: true }).click();
  await panel.getByRole("button", { name: "管理记忆", exact: true }).click();
  await expect.poll(() => memoryStarted).toBe(true);
  await page.goto("/login");
  releaseMemory(); // Unmount while the memory request is still pending.
  await page.waitForTimeout(300);
  await expect(page.getByText("obsolete-memory", { exact: true })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
  await api.dispose();
});

test("conversation drafts survive switching and refresh; filters and assistant panels stay usable", async ({
  page,
}) => {
  const { api, a, b, room, create } = await setup();
  const c = await create(3);
  await api.post("friend/add_friend", {
    headers: { Authorization: `Bearer ${a.token}` },
    data: { id: c.info.id, username: c.username },
  });
  const chats = (
    await (
      await api.get("message/chat_list", {
        headers: { Authorization: `Bearer ${a.token}` },
      })
    ).json()
  ).data;
  const otherRoom = chats.find(
    (item: { room: string }) => item.room !== room,
  ).room;
  await login(page, a, room);
  const input = page.getByLabel("消息输入框");
  await input.fill("会话一未发送的草稿");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
  await input.press("ArrowRight");
  await page.locator(`[id="chatList_${otherRoom}"]`).click();
  await expect(input).toHaveValue("");
  await input.fill("会话二自己的草稿");
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect(input).toHaveValue("会话一未发送的草稿");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([4, 4]);
  await page.reload();
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect(input).toHaveValue("会话一未发送的草稿");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([4, 4]);

  const filter = page.getByLabel("搜索会话或联系人");
  await filter.fill(b.username.toUpperCase());
  await expect(page.locator(`[id="chatList_${room}"]`)).toBeVisible();
  await expect(page.locator(`[id="chatList_${otherRoom}"]`)).toHaveCount(0);
  await filter.fill("没有这个联系人");
  await expect(page.getByText("没有匹配的会话，试试姓名或账号")).toBeVisible();
  await filter.fill("");
  await expect(page.locator(`[id="chatList_${otherRoom}"]`)).toBeVisible();
  await page.getByRole("button", { name: "添加好友或群聊" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitem", { name: "加好友/加群" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await input.press("Enter");
  await expect(input).toHaveValue("");
  await page.locator(`[id="chatList_${otherRoom}"]`).click();
  await expect(input).toHaveValue("会话二自己的草稿");
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect(input).toHaveValue("");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("pomelo-chat.draft."))
        throw new DOMException("Unavailable", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await input.fill("存储失败时仍保留草稿");
  await page.locator(`[id="chatList_${otherRoom}"]`).click();
  await input.fill("存储失败时更新已有草稿");
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect(input).toHaveValue("存储失败时仍保留草稿");
  await page.locator(`[id="chatList_${otherRoom}"]`).click();
  await expect(input).toHaveValue("存储失败时更新已有草稿");

  let releaseReply!: () => void;
  const replyWait = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let started = false;
  await page.route("**/assistant/agent/stream", async (route) => {
    started = true;
    await replyWait;
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: result\ndata: {"content":"界面回归回答","actions":[],"toolTrace":[{"tool":"search_chat","status":"success"}]}\n\n',
    });
  });
  await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
  await input.fill("发出这一段");
  await input.press("Enter");
  await expect.poll(() => started).toBe(true);
  await expect(input).toHaveValue('');
  await input.fill("回答生成期间写的新草稿");
  releaseReply();
  await expect(
    page.locator("[data-message-index]").getByText(/界面回归回答/),
  ).toBeVisible();
  await expect(input).toHaveValue("回答生成期间写的新草稿");
  await page.getByRole("button", { name: "打开 Copilot", exact: true }).click();
  const panel = page.getByRole("complementary", {
    name: "AI Copilot 助手面板",
  });
  await expect(
    panel.getByRole("tab", { name: "回复", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("region", { name: "当前回答" })).toContainText(
    "界面回归回答",
  );
  await expect(panel.getByText("search_chat", { exact: true })).toBeHidden();
  await panel.locator("summary").filter({ hasText: "执行详情" }).click();
  await expect(panel.getByText("search_chat", { exact: true })).toBeVisible();
  await panel.getByRole("tab", { name: "待办", exact: true }).click();
  await expect(panel.getByLabel("选择聊天会话")).toBeVisible();
  await panel.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(panel.getByRole("button", { name: "管理记忆" })).toBeVisible();
  await expect(panel.getByLabel("选择聊天会话")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("assistant-tabs.png") });
  const isolation = await page.evaluate(
    async ({ userId, room }) => {
      const path = "/src/utils/chat-drafts.ts";
      const drafts = await import(path);
      const foreign = drafts.readDraft(
        drafts.draftKey(userId + 9999, room),
      ).text;
      drafts.clearUserDrafts(userId);
      return {
        foreign,
        own: drafts.readDraft(drafts.draftKey(userId, room)).text,
      };
    },
    { userId: a.info.id, room },
  );
  expect(isolation).toEqual({ foreign: "", own: "" });
  await api.dispose();
});

test.describe("touch chat interactions", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("search uses the full pane and failed messages expose retry without hover", async ({
    page,
  }) => {
    const { api, a, room } = await setup();
    let failNext = false;
    await page.routeWebSocket("**/message/connect_chat?**", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (failNext && frame.content === "触屏发送失败") {
          failNext = false;
          socket.send(
            JSON.stringify({
              name: "error",
              client_msg_id: frame.clientMsgId,
              message: "请检查消息后重试",
            }),
          );
        } else server.send(raw);
      });
    });
    await login(page, a, room);
    const input = page.getByLabel("消息输入框");
    await input.fill("可搜索的触屏消息");
    await input.press("Enter");
    const message = page
      .locator("[data-message-index]")
      .filter({ hasText: "可搜索的触屏消息" });
    await expect(message.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
    await message.getByRole("button", { name: "消息更多操作" }).tap();
    await expect(
      page.getByRole("menuitem", { name: "复制", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "搜索聊天记录", exact: true }).tap();
    const search = page.getByRole("complementary", { name: "聊天记录搜索" });
    await expect(input).toBeHidden();
    const layout = await search.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement!.getBoundingClientRect();
      return {
        inside: rect.left >= 0 && rect.right <= innerWidth,
        full: Math.abs(rect.width - parent.width) < 2,
      };
    });
    expect(layout).toEqual({ inside: true, full: true });
    await search.getByLabel("聊天记录关键词").fill("可搜索的触屏消息");
    await search.getByRole("button", { name: "搜索", exact: true }).tap();
    await page.screenshot({
      path: test.info().outputPath("mobile-search.png"),
    });
    await search.getByRole("button", { name: /可搜索的触屏消息/ }).tap();
    await expect(search).toHaveCount(0);
    await expect(message).toBeVisible();
    await page.getByRole("button", { name: "返回最新消息", exact: true }).tap();
    await expect(input).toBeVisible();
    failNext = true;
    await input.fill("触屏发送失败");
    await input.press("Enter");
    const failed = page
      .locator("[data-message-index]")
      .filter({ hasText: "触屏发送失败" });
    await expect(
      failed.getByRole("button", { name: "重新发送", exact: true }),
    ).toBeVisible();
    await failed.getByRole("button", { name: "重新发送", exact: true }).tap();
    await expect(failed.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "会话列表", exact: true }).tap();
    await expect(page.getByLabel("搜索会话或联系人")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("mobile-conversations.png"),
    });
    await api.dispose();
  });
});
