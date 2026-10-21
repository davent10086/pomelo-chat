import { testApiURL } from "./helpers/endpoints";
import { test, expect, request } from "@playwright/test";
import { setup, createUserFactory } from "./helpers/chat";

test("contact search paginates, encodes keywords, and ignores superseded requests", async ({ page }) => {
  const api = await request.newContext({ baseURL: testApiURL });
  const { username, password } = await createUserFactory(api, 'search')(1);
  try {
    await page.goto("/login");
    await page.getByPlaceholder("请输入用户名").fill(username);
    await page.getByPlaceholder("请输入密码").fill(password);
    await page.locator("button[type=submit]").click();
    await page.getByRole("button", { name: "添加好友或群聊" }).click();
    await page.getByRole("menuitem", { name: "加好友/加群", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const keyword = "a&b%_!";
    let releaseOld: (() => void) | undefined;
    let oldRequested = false;
    await page.route("**/friend/search_user?**", async route => {
      const params = new URL(route.request().url()).searchParams;
      const term = params.get("username");
      if (term === "old") {
        oldRequested = true;
        await new Promise<void>(resolve => { releaseOld = resolve; });
      }
      const afterId = Number(params.get("afterId"));
      const rows = term === keyword ? Array.from({ length: afterId ? 2 : 30 }, (_, offset) => {
        const id = afterId + offset + 1;
        return { id, username: `page_user_${id}`, name: "", avatar: "", status: false };
      }) : [{ id: 100, username: term === "old" ? "stale_user" : "latest_user", name: "", avatar: "", status: false }];
      await route.fulfill({ json: { code: 200, data: rows } }).catch(() => {});
    });
    const input = dialog.getByPlaceholder("请输入对方的用户名");
    await input.fill(keyword);
    await dialog.getByRole("button", { name: /查\s*找/ }).click();
    await expect(dialog.getByText("page_user_30 (page_user_30)", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "加载更多" }).click();
    await expect(dialog.getByText("page_user_32 (page_user_32)", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "加载更多" })).toHaveCount(0);
    await input.fill("old");
    await dialog.getByRole("button", { name: /查\s*找/ }).click();
    await expect.poll(() => oldRequested).toBeTruthy();
    await input.fill("new");
    await dialog.getByRole("button", { name: /查\s*找/ }).click();
    await expect(dialog.getByText("latest_user (latest_user)", { exact: true })).toBeVisible();
    releaseOld?.();
    await expect(dialog.getByText("stale_user (stale_user)", { exact: true })).toHaveCount(0);
    await dialog.getByRole("tab", { name: "加群", exact: true }).click();
    await page.route("**/group/search_group?**", async route => {
      const afterId = Number(new URL(route.request().url()).searchParams.get("afterId"));
      const data = Array.from({ length: afterId ? 1 : 30 }, (_, offset) => ({ group_id: afterId + offset + 1, name: `page_group_${afterId + offset + 1}`, avatar: "", number: 2, status: false }));
      await route.fulfill({ json: { code: 200, data } });
    });
    await dialog.getByPlaceholder("请输入群名称").fill("groups");
    await dialog.getByRole("button", { name: /查\s*找/ }).click();
    await dialog.getByRole("button", { name: "加载更多" }).click();
    await expect(dialog.getByText("page_group_31 (2人)", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "加载更多" })).toHaveCount(0);
  } finally { await api.dispose(); }
});

test("real login, message ACK, suggestions, room isolation, streaming and password change", async ({
  page,
}) => {
  const { api, a, b, room } = await setup();
  await page.routeWebSocket("**/message/connect_chat?**", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.content !== "gap-hidden-message") socket.send(raw);
    });
  });
  await page.route("**/assistant/agent", (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.context.readOnly).toBe(true);
    expect(payload.context.memoryEnabled).toBe(false);
    expect(payload.input).toBeTruthy();
    return route.fulfill({
      json: {
        code: 200,
        message: "success",
        data: { content: "回复建议", replySuggestions: ["已收到，我来确认细节", "请补充信息"] },
      },
    });
  });
  await page.goto("/login");
  await page.getByPlaceholder("请输入用户名").fill(a.username);
  await page.getByPlaceholder("请输入密码").fill(a.password);
  await page.locator("button[type=submit]").click();
  await expect(page).toHaveURL(/\/$/);
  await page.locator(`[id="chatList_${room}"]`).click();
  const input = page.getByLabel("消息输入框");
  await input.fill("browser-message");
  await input.press("Enter");
  await expect(
    page
      .locator("div")
      .filter({ hasText: /^browser-message$/ })
      .last(),
  ).toBeVisible();
  await expect(page.getByRole('status', { name: '已发送', exact: true })).toBeVisible();
  // Drop one real server frame without closing the browser socket. The next
  // sequence must trigger HTTP catchup and restore the missing message once.
  await page.evaluate(
    async ({ room, user, receiver }) => {
      const { wsBaseURL: testWsBaseURL, apiBaseURL: testBrowserApiURL } = await import("/src/config/index.ts");

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          `${testWsBaseURL}/message/connect_chat?room=${encodeURIComponent(room)}&id=${user.info.id}&type=private`,
          ["pomelo-token", user.token],
        );
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("Peer ACK timeout"));
        }, 10000);
        const send = (content: string) =>
          socket.send(
            JSON.stringify({
              sender_id: user.info.id,
              receiver_id: receiver,
              content,
              type: "private",
              clientMsgId: `browser_${content}_${Date.now()}`,
            }),
          );
        let sent = 0;
        socket.onmessage = (event) => {
          const frame = JSON.parse(event.data);
          if (frame.name === "history" && sent === 0) {
            sent = 1;
            send("gap-hidden-message");
          } else if (frame.name === "ack" && sent === 1) {
            sent = 2;
            send("gap-visible-message");
          } else if (frame.name === "ack" && sent === 2) {
            clearTimeout(timer);
            socket.close();
            resolve();
          } else if (frame.name === "error") {
            clearTimeout(timer);
            socket.close();
            reject(new Error("Peer send failed"));
          }
        };
      });
    },
    { room, user: b, receiver: a.info.id },
  );
  await expect(
    page.locator("[data-message-index]").getByText("gap-hidden-message", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.locator("[data-message-index]").getByText("gap-visible-message", { exact: true }),
  ).toHaveCount(1);
  await input.fill("已有草稿");
  await input.press("Tab");
  await expect(page.getByText("候选回复", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "已收到，我来确认细节", exact: true })
    .first()
    .click();
  await expect(input).toHaveValue(/已有草稿/);
  await page.route("**/assistant/agent/stream", async route => {
    const payload = route.request().postDataJSON();
    expect(payload.context.readOnly).toBe(true);
    expect(payload.context.recentMessagesText).toContain("browser-message");
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: delta\ndata: {"delta":"旧总结","reset":false}\n\nevent: delta\ndata: {"delta":"统一接口总结","reset":true}\n\ndata: {"content":"统一接口总结","actions":[]}\n\ndata: [DONE]\n\n',
    });
  });
  await page.getByRole("button", { name: "总结聊天", exact: true }).click();
  const summaryDialog = page.getByRole("dialog", { name: "聊天记录总结" });
  await expect(summaryDialog).toContainText("统一接口总结");
  await expect(summaryDialog).not.toContainText("旧总结");
  await summaryDialog.getByRole("button", { name: /关\s*闭/ }).click();
  await page.unroute("**/assistant/agent/stream");
  await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
  await expect(input).toHaveValue("");
  await page.route("**/assistant/agent/stream", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: delta\ndata: {"delta":"第一段"}\n\nevent: delta\ndata: {"delta":"，第二段"}\n\nevent: result\ndata: {"content":"第一段，第二段","actions":[]}\n\n',
    });
  });
  await input.fill("stream-test");
  await input.press("Enter");
  await expect(
    page.getByText("第一段，第二段", { exact: true }).last(),
  ).toBeVisible();
  await page.locator("img").first().hover();
  await page.getByRole("button", { name: /修改密码/ }).click();
  await page.getByPlaceholder("请输入当前密码").fill(a.password);
  await page.getByPlaceholder("请输入新的密码").fill("Changed123!");
  await page.getByPlaceholder("确认新的密码").fill("Changed123!");
  await page.getByRole("button", { name: /确\s*认/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  const old = await api.post("auth/login", {
    data: { username: a.username, password: a.password },
  });
  expect(old.ok()).toBeFalsy();
  const changed = await api.post("auth/login", {
    data: { username: a.username, password: "Changed123!" },
  });
  expect(changed.ok()).toBeTruthy();
  await api.dispose();
});
