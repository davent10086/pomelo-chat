import { expect, request, type Page } from "@playwright/test";

export const setup = async () => {
  const api = await request.newContext({
    baseURL: "http://127.0.0.1:3199/api/chat/v1/",
  });
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const create = async (index: number) => {
    const username = `recover_${stamp}_${index}`,
      password = "Recover123!";
    await api.post("auth/register", {
      data: {
        username,
        password,
        phone: `13${String(BigInt(stamp) + BigInt(index)).slice(-9)}`,
        avatar: "",
      },
    });
    const login = await api.post("auth/login", {
      data: { username, password },
    });
    return { username, password, ...(await login.json()).data };
  };
  const a = await create(1),
    b = await create(2);
  await api.post("friend/add_friend", {
    headers: { Authorization: `Bearer ${a.token}` },
    data: { id: b.info.id, username: b.username },
  });
  const chats = await api.get("message/chat_list", {
    headers: { Authorization: `Bearer ${a.token}` },
  });
  const room = (await chats.json()).data[0].room as string;
  return { api, a, b, room, create };
};
export const login = async (
  page: Page,
  user: { username: string; password: string },
  room: string,
) => {
  await page.goto("/login");
  await page.getByPlaceholder("请输入用户名").fill(user.username);
  await page.getByPlaceholder("请输入密码").fill(user.password);
  await page.locator("button[type=submit]").click();
  await page.locator(`[id="chatList_${room}"]`).click();
  await expect(page.getByLabel("消息输入框")).toBeVisible();
};
