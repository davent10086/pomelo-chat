import { test, expect } from "@playwright/test";
import { setup, login } from "./helpers/chat";

test.setTimeout(30000);

test("reply suggestions ignore cancelled requests and keyboard selection inserts the selected item", async ({ page }) => {
  const { api, a, room } = await setup();
  let release!: () => void;
  let releaseCancel!: () => void;
  let delayed = false;
  let cancelStarted = false;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const cancelWait = new Promise<void>(resolve => { releaseCancel = resolve; });
  await page.route("**/assistant/agent", async route => {
    const input = String(route.request().postDataJSON().input);
    if (input.endsWith("旧草稿")) { delayed = true; await wait; }
    if (input.endsWith("取消草稿")) { cancelStarted = true; await cancelWait; }
    await route.fulfill({ json: { code: 200, data: {
      content: "回复建议", replySuggestions: input.endsWith("旧草稿") ? ["过期候选"] : ["候选甲", "候选乙"]
    } } }).catch(() => undefined);
  });
  try {
    await login(page, a, room);
    const input = page.getByLabel("消息输入框");
    await input.fill("旧草稿");
    await input.press("Tab");
    await expect.poll(() => delayed).toBe(true);
    await input.fill("新草稿");
    release();
    await page.waitForTimeout(200);
    await expect(page.getByText("候选回复", { exact: true })).toHaveCount(0);
    await expect(input).toHaveValue("新草稿");
    await input.press("Tab");
    await expect(page.getByText("候选回复", { exact: true })).toBeVisible();
    await input.press("Tab");
    await input.press("ArrowRight");
    await expect(input).toHaveValue("新草稿候选乙");
    await expect(page.getByText("候选回复", { exact: true })).toHaveCount(0);
    await input.press("Tab");
    await expect(page.getByText("候选回复", { exact: true })).toBeVisible();
    await input.press("Escape");
    await expect(page.getByText("候选回复", { exact: true })).toHaveCount(0);
    await input.fill("取消草稿");
    await input.press("Tab");
    await expect.poll(() => cancelStarted).toBe(true);
    await input.press("Escape");
    releaseCancel();
    await page.waitForTimeout(200);
    await expect(page.getByText("候选回复", { exact: true })).toHaveCount(0);
    await expect(input).toHaveValue("取消草稿");
  } finally { release(); releaseCancel(); await api.dispose(); }
});

test("assistant actions preserve task selection, query uncertain writes and retry only on request", async ({ page }) => {
  const { api, a, room } = await setup();
  const confirmations: Array<{ confirmationId: string; taskIndexes?: number[] }> = [];
  const cancellations: string[] = [];
  let candidate = 0;
  let memoryProposal = 0;
  let memoryDeleted = false;
  let releaseConfirm!: () => void;
  const confirmWait = new Promise<void>(resolve => { releaseConfirm = resolve; });
  let started = false;
  await page.route("**/assistant/agent", route => route.fulfill({ json: { code: 200, data: { content: "", replySuggestions: [] } } }));
  await page.route("**/assistant/tasks", route => route.fulfill({ json: { code: 200, data: { tasks: [] } } }));
  await page.route("**/assistant/agent/task-candidates", route => {
    candidate++;
    return route.fulfill({ json: { code: 200, data: {
      todos: [{ title: "事项甲", sources: [] }, { title: "事项乙", sources: [] }],
      action: { type: "create_tasks", requiresConfirmation: true, payload: {}, confirmationId: `tasks-${candidate}` }
    } } });
  });
  await page.route("**/assistant/actions/*", async route => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    if (id === "confirm") {
      const body = route.request().postDataJSON();
      confirmations.push(body);
      if (body.confirmationId === "memory-2") memoryDeleted = true;
      if (body.confirmationId === "tasks-1") {
        started = true;
        await confirmWait;
        await route.fulfill({ status: 503, json: { code: 1001 } });
        return;
      }
      await route.fulfill({ json: { code: 200, data: { confirmationId: body.confirmationId, type: "create_tasks", status: "completed" } } });
    } else if (id === "cancel") {
      cancellations.push(route.request().postDataJSON().confirmationId);
      await route.fulfill({ json: { code: 200, data: {} } });
    } else {
      await route.fulfill({ json: { code: 200, data: {
        confirmationId: id, type: "create_tasks", status: id === "tasks-1" ? "completed" : "pending", retryable: id === "tasks-2"
      } } });
    }
  });
  await page.route("**/assistant/agent/stream", route => route.fulfill({ contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ content: "这里是待确认草稿", actions: [{
      type: "send_message", requiresConfirmation: true, payload: { content: "草稿" }, confirmationId: "message-1"
    }] })}\n\ndata: [DONE]\n\n`
  }));
  await page.route("**/assistant/agent/tools/call", route => {
    const name = route.request().postDataJSON().name;
    if (name === "forget_memory") memoryProposal++;
    return route.fulfill({ json: { code: 200, data: { name, result: name === "search_memory"
      ? { memories: memoryDeleted ? [] : [{ id: 1, content: "保留的记忆" }] }
      : { type: "forget_memory", confirmationId: `memory-${memoryProposal}`, payload: { content: "保留的记忆" } }
    } } });
  });
  try {
    await login(page, a, room);
    await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
    await page.getByRole("button", { name: "打开 Copilot", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "AI Copilot 助手面板" });
    await panel.getByRole("tab", { name: "待办", exact: true }).click();
    await panel.getByLabel("选择聊天会话").selectOption(room);
    await panel.getByRole("button", { name: "整理事项" }).click();
    await panel.getByRole("checkbox", { name: "事项乙" }).check();
    await panel.getByRole("button", { name: "确认保存所选" }).click();
    await expect.poll(() => started).toBe(true);
    await panel.getByRole("button", { name: "查询结果／重试确认" }).click();
    expect(confirmations).toEqual([{ confirmationId: "tasks-1", taskIndexes: [1] }]);
    releaseConfirm();
    await expect(panel.getByText("已完成", { exact: true })).toBeVisible();
    expect(confirmations).toHaveLength(1);
    await panel.getByRole("button", { name: "整理事项" }).click();
    await expect(panel.getByText("待确认", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "查询结果／重试确认" }).click();
    await expect(panel.getByText("已完成", { exact: true })).toBeVisible();
    expect(confirmations[1]).toEqual({ confirmationId: "tasks-2" });
    await panel.getByRole("button", { name: "整理事项" }).click();
    await panel.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(panel.getByText("已取消", { exact: true })).toBeVisible();
    expect(cancellations).toEqual(["tasks-3"]);
    await page.getByLabel("消息输入框").fill("生成一个草稿");
    await page.getByLabel("消息输入框").press("Enter");
    await panel.getByRole("button", { name: "确认发送" }).click();
    await expect(panel.getByRole("button", { name: "确认发送" })).toHaveCount(0);
    expect(confirmations[2]).toEqual({ confirmationId: "message-1" });
    await panel.getByRole("tab", { name: "记忆", exact: true }).click();
    await panel.getByRole("button", { name: "管理记忆" }).click();
    const memories = page.getByRole("dialog").filter({ has: page.getByText("AI 记忆管理", { exact: true }) });
    await memories.getByRole("button", { name: /删\s*除/ }).click();
    const confirmation = page.getByRole("dialog").filter({ hasText: "确认删除这条记忆？" });
    await confirmation.getByRole("button", { name: /取\s*消/ }).click();
    await expect.poll(() => cancellations).toEqual(["tasks-3", "memory-1"]);
    await expect(memories.getByText("保留的记忆", { exact: true })).toBeVisible();
    expect(confirmations).toHaveLength(3);
    await memories.getByRole("button", { name: /删\s*除/ }).click();
    await page.getByRole("dialog").filter({ hasText: "确认删除这条记忆？" }).getByRole("button", { name: /删\s*除/ }).click();
    await expect(memories.getByText("暂无长期记忆", { exact: true })).toBeVisible();
    expect(confirmations[3]).toEqual({ confirmationId: "memory-2" });
  } finally { releaseConfirm(); await api.dispose(); }
});


test('suggestion chips and Copilot use one scoped cursor insertion path', async ({ page }) => {
  const { api, a, room } = await setup();
  await page.route('**/assistant/agent', route => route.fulfill({ json: { code: 200, data: { content: '建议', replySuggestions: ['统一建议'] } } }));
  await page.route('**/assistant/agent/stream', route => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ content: '回答', replySuggestions: ['面板建议'], todos: [], actions: [] })}\n\ndata: [DONE]\n\n` }));
  try {
    await login(page, a, room);
    const input = page.getByLabel('消息输入框');
    await input.fill('触发建议');
    await input.press('Enter');
    const chip = page.getByRole('button', { name: '统一建议', exact: true });
    await expect(chip).toBeVisible();
    await input.fill('AB');
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(1, 1));
    await chip.click();
    await expect(input).toHaveValue('A统一建议B');
    await chip.click();
    await expect(input).toHaveValue('A统一建议统一建议B');
    await page.locator(`[id="chatList_ai_${a.info.id}"]`).click();
    await expect(input).toHaveValue('');
    await input.fill('提问');
    await input.press('Enter');
    await page.getByRole('button', { name: '打开 Copilot', exact: true }).click();
    await page.getByRole('complementary', { name: 'AI Copilot 助手面板' }).getByRole('button', { name: '面板建议', exact: true }).click();
    await expect(input).toHaveValue('面板建议');
    await page.locator(`[id="chatList_${room}"]`).click();
    await expect(input).toHaveValue('A统一建议统一建议B');
  } finally { await api.dispose(); }
});
