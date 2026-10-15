import { test, expect } from '@playwright/test';
import { setup, login } from './helpers/chat';

test('address book keeps current selection, saves friend data and shows group details', async ({ page }) => {
  const { api, a, b, room, create } = await setup();
  const c = await create(3);
  const headers = { Authorization: `Bearer ${a.token}` };
  expect((await api.post('friend/add_friend', { headers, data: { id: c.info.id, username: c.username } })).ok()).toBeTruthy();
  const groupName = '通讯录回归群';
  expect((await api.post('group/create_group', { headers, data: {
    name: groupName, avatar: '', announcement: '回归公告', members: [{ user_id: b.info.id, username: b.username }]
  } })).ok()).toBeTruthy();
  const friends = (await (await api.get('friend/friend_list', { headers })).json()).data;
  const oldId = friends.flatMap((group: { friend: Array<{ id: number; username: string }> }) => group.friend)
    .find((friend: { username: string }) => friend.username === b.username).id;
  let oldStarted = false;
  let oldFinished = false;
  let release!: () => void;
  const oldWait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/friend/friend_id/**', async route => {
    const response = await route.fetch();
    const old = Number(new URL(route.request().url()).searchParams.get('id')) === oldId;
    if (old) { oldStarted = true; await oldWait; }
    await route.fulfill({ response }).catch(() => undefined);
    if (old) oldFinished = true;
  });
  try {
    await login(page, a, room);
    await page.getByRole('button', { name: '通讯录', exact: true }).click();
    const tree = page.getByRole('tree');
    await tree.getByRole('img', { name: 'caret-down' }).first().click();
    await tree.getByText(b.username, { exact: true }).click();
    await expect.poll(() => oldStarted).toBe(true);
    await tree.getByText(c.username, { exact: true }).click();
    const details = page.getByRole('region', { name: '好友资料' });
    await expect(details.getByLabel('账号', { exact: true })).toHaveValue(c.username);
    release();
    await expect.poll(() => oldFinished).toBe(true);
    await expect(details.getByLabel('账号', { exact: true })).toHaveValue(c.username);
    await details.getByPlaceholder('请输入好友备注').fill('新的通讯录备注');
    const saved = page.waitForResponse(response => response.url().endsWith('/friend/update_friend'));
    await details.getByRole('button', { name: '保存信息' }).click();
    expect((await saved).ok()).toBeTruthy();
    await expect(tree.getByText('新的通讯录备注', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '好友', exact: true }).click({ button: 'right' });
    await page.getByText('新建分组', { exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建分组' });
    await dialog.getByPlaceholder('请输入分组名称').fill('回归分组');
    await dialog.getByRole('button', { name: /确\s*定/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(tree.getByText(/回归分组/)).toBeVisible();
    await page.getByPlaceholder('搜索联系人或群聊').fill('新的通讯录备注');
    await expect(tree.getByText('新的通讯录备注', { exact: true })).toBeVisible();
    await expect(tree.getByText(b.username, { exact: true })).toHaveCount(0);
    await page.getByPlaceholder('搜索联系人或群聊').fill('');
    await page.getByRole('tab', { name: '群聊', exact: true }).click();
    await page.getByText(groupName, { exact: true }).click();
    const group = page.getByRole('region', { name: '群聊详情' });
    await expect(group.getByText('回归公告', { exact: true })).toBeVisible();
    await group.getByRole('tab', { name: '成员', exact: true }).click();
    await expect(group.getByText(b.username, { exact: true }).first()).toBeVisible();
    await group.getByRole('button', { name: '邀请好友' }).click();
    const invitation = page.getByRole('dialog').filter({ hasText: '邀请新的好友进群聊' });
    await expect(invitation).toBeVisible();
    await invitation.getByRole('button', { name: 'Close', exact: true }).click();
    await group.getByRole('button', { name: '发送消息' }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByLabel('消息输入框')).toBeVisible();
  } finally { release(); await api.dispose(); }
});
