import { test, expect, request as playwrightRequest } from "@playwright/test";

const appUrl = process.env.QA_APP_URL || "http://127.0.0.1:5173";
const apiBase = process.env.QA_API_BASE || "http://127.0.0.1:3000/api/chat/v1";

test("login and chat with built-in AI assistant", async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: apiBase });
  const runId = Date.now();
  const username = `qa_e2e_${runId}`;
  const password = "Qa123456!";
  const phone = `13${String(runId).slice(-9).padStart(9, "0")}`;

  await api.post("/auth/register", {
    data: { username, password, phone, avatar: "" },
  });

  await page.goto(`${appUrl}/login`);
  await page.locator("input").nth(0).fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();

  await expect(page).toHaveURL(/\/($|chat|address-book)/, { timeout: 15000 });

  await page.goto(`${appUrl}/address-book`);
  await page.getByText("AI", { exact: true }).click();

  const textarea = page.locator("textarea");
  await expect(textarea).toBeVisible({ timeout: 10000 });
  await textarea.fill("你好，你是谁？");
  await page
    .locator("button")
    .filter({ hasText: /发送|鍙戦€/ })
    .last()
    .click();

  await expect(
    page.locator("text=Pomelo").or(page.locator("text=AI")),
  ).toBeVisible({ timeout: 60000 });
});

test("selects a chat, reviews cited tasks, and saves only checked items", async ({
  page,
}) => {
  const api = await playwrightRequest.newContext({ baseURL: apiBase });
  const runId = Date.now();
  const username = `qa_tasks_${runId}`;
  const password = "Qa123456!";
  const phone = `13${String(runId).slice(-9).padStart(9, "0")}`;
  await api.post("/auth/register", {
    data: { username, password, phone, avatar: "" },
  });

  const conversation = {
    receiver_id: 42,
    receiver_username: "teammate",
    name: "项目讨论",
    room: "qa-task-room",
    updated_at: new Date().toISOString(),
    unreadCount: 0,
    lastMessage: "明天完成测试",
    type: "text",
    avatar: "",
  };
  await page.route("**/message/chat_list", (route) =>
    route.fulfill({
      json: { code: 200, message: "success", data: [conversation] },
    }),
  );
  await page.route("**/assistant/tasks", (route) =>
    route.fulfill({
      json: { code: 200, message: "success", data: { tasks: [] } },
    }),
  );
  await page.route("**/assistant/agent/task-candidates", (route) =>
    route.fulfill({
      json: {
        code: 200,
        message: "success",
        data: {
          todos: [
            {
              title: "完成测试",
              sources: [
                {
                  id: 12,
                  content: "明天完成测试",
                  createdAt: new Date().toISOString(),
                },
              ],
            },
            {
              title: "更新文档",
              sources: [
                {
                  id: 13,
                  content: "更新文档",
                  createdAt: new Date().toISOString(),
                },
              ],
            },
          ],
          action: {
            type: "create_tasks",
            requiresConfirmation: true,
            payload: {},
            confirmationId: "qa-confirmation",
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        },
      },
    }),
  );
  let submittedIndexes: number[] = [];
  await page.route("**/assistant/actions/confirm", async (route) => {
    submittedIndexes = route.request().postDataJSON().taskIndexes;
    await route.fulfill({
      json: {
        code: 200,
        message: "success",
        data: {
          confirmationId: "qa-confirmation",
          type: "create_tasks",
          status: "completed",
          result: { created: [{ id: 1, title: "完成测试" }] },
        },
      },
    });
  });

  await page.goto(`${appUrl}/login`);
  await page.locator("input").nth(0).fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/($|chat|address-book)/, { timeout: 15000 });
  await page.goto(`${appUrl}/address-book`);
  await page.getByText("AI", { exact: true }).click();
  await page.getByRole("button", { name: "打开 Copilot" }).click();
  await page.getByRole("tab", { name: "待办", exact: true }).click();
  await page.getByLabel("选择聊天会话").selectOption("qa-task-room");
  await page.getByRole("button", { name: "整理事项" }).click();
  await expect(page.getByRole("button", { name: /原消息 #12/ })).toBeVisible();
  await page.getByRole("button", { name: /原消息 #12/ }).click();
  await expect(
    page.getByText("项目讨论", { exact: true }).last(),
  ).toBeVisible();
  await page.locator('[id^="chatList_ai_"]').click();
  await page.getByRole("button", { name: "打开 Copilot" }).click();
  await page.getByRole("tab", { name: "待办", exact: true }).click();
  await page.getByLabel("完成测试").check();
  await page.getByRole("button", { name: "确认保存所选" }).click();
  await expect.poll(() => submittedIndexes).toEqual([0]);
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
});
