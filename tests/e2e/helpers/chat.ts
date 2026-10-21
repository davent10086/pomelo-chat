import { testApiURL, testWebOrigin } from "./endpoints";
import { expect, request, type Page } from "@playwright/test";

export const createUserFactory = (
  api: import("@playwright/test").APIRequestContext,
  prefix = "browser",
) => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return async (index: number) => {
    const username = `${prefix}_${stamp}_${index}`,
      password = "Browser123!";
    expect(
      (
        await api.post("auth/register", {
          data: {
            username,
            password,
            phone: `13${String(BigInt(stamp) + BigInt(index)).slice(-9)}`,
            avatar: "",
          },
        })
      ).ok(),
    ).toBeTruthy();
    const response = await api.post("auth/login", {
      data: { username, password },
    });
    expect(response.ok()).toBeTruthy();
    return { username, password, ...(await response.json()).data };
  };
};

export const connectFriends = async (
  api: import("@playwright/test").APIRequestContext,
  a: { token: string },
  b: { info: { id: number }; username: string },
): Promise<string> => {
  expect(
    (
      await api.post("friend/add_friend", {
        headers: { Authorization: `Bearer ${a.token}` },
        data: { id: b.info.id, username: b.username },
      })
    ).ok(),
  ).toBeTruthy();
  const response = await api.get("message/chat_list", {
    headers: { Authorization: `Bearer ${a.token}` },
  });
  expect(response.ok()).toBeTruthy();
  const room = (await response.json()).data.find(
    (item: { receiver_id: number }) => Number(item.receiver_id) === b.info.id,
  )?.room;
  expect(room).toBeTruthy();
  return room;
};

export const setup = async () => {
  const api = await request.newContext({
    baseURL: testApiURL,
  });
  try {
    const create = createUserFactory(api);
    const a = await create(1),
      b = await create(2);
    const room = await connectFriends(api, a, b);
    return { api, a, b, room, create };
  } catch (error) {
    await api.dispose();
    throw error;
  }
};
export const login = async (
  page: Page,
  user: { username: string; password: string },
  room?: string,
) => {
  await page.goto(`${testWebOrigin}/login`);
  await page.getByPlaceholder("请输入用户名").fill(user.username);
  await page.getByPlaceholder("请输入密码").fill(user.password);
  await page.locator("button[type=submit]").click();
  await expect(page).toHaveURL(/\/$/);
  if (room) {
    await page.locator(`[id="chatList_${room}"]`).click();
    await expect(page.getByLabel("消息输入框")).toBeVisible();
  }
};
