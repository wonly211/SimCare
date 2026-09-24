import { expect, test, type Page } from '@playwright/test';
import type {
  ApiResponse,
  HealthInput,
  Session,
  SyncOperation,
  SyncSnapshot,
} from '../../packages/shared/src/index';

const origin = 'http://localhost:8877';
async function api<T>(page: Page, path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { Origin: origin },
    ...(data === undefined ? {} : { data }),
  });
  const body = (await response.json()) as ApiResponse<T>;
  expect(body.success, JSON.stringify(body)).toBe(true);
  if (!body.success) throw new Error(body.error.message);
  return body.data;
}
async function login(page: Page): Promise<Session> {
  return api<Session>(page, '/auth/admin-recover', 'POST', {
    phone: '13800000000',
    initKey: 'e2e-only-not-a-production-secret',
    deviceName: '测试管理员设备',
  });
}

test('手机号初始化与审批、权限、健康与用药、离线同步、设备与备份恢复', async ({
  page,
  context,
  browser,
}) => {
  await page.goto('/');
  await page.getByLabel('手机号', { exact: true }).fill('13800000000');
  await page.getByLabel('姓名或昵称').fill('测试管理员');
  await page.getByLabel('初始化密钥').fill('e2e-only-not-a-production-secret');
  await page.getByRole('button', { name: '建立家庭', exact: true }).click();
  await expect(page.getByText('测试管理员').first()).toBeVisible();
  const admin = await api<Session>(page, '/auth/session');
  await page.reload();
  await expect(page.getByText('测试管理员').first()).toBeVisible();
  const initial = await api<SyncSnapshot>(page, '/sync/pull');
  const input: HealthInput = {
    ownerId: admin.user.id,
    measuredAt: '2026-09-22T08:00:00+08:00',
    systolic: 120,
    diastolic: 80,
    pulse: 70,
    oxygen: null,
    temperature: null,
    posture: 'sitting',
    arm: 'left',
    note: '虚构测试数据',
  };
  const operation: SyncOperation = {
    operationId: crypto.randomUUID(),
    epoch: initial.epoch,
    resource: 'health',
    recordId: crypto.randomUUID(),
    baseVersion: 0,
    action: 'upsert',
    data: input,
  };
  await api(page, '/sync/push', 'POST', { operations: [operation] });
  await api(page, '/sync/push', 'POST', { operations: [operation] });
  expect((await api<SyncSnapshot>(page, '/sync/pull')).healthRecords).toHaveLength(1);
  const invitation = await api<{ token: string }>(page, '/invitations', 'POST', { role: 'member' });
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await memberPage.goto('/?invite=' + invitation.token);
  await memberPage.getByLabel('手机号', { exact: true }).fill('13800000001');
  await memberPage.getByLabel('姓名或昵称').fill('测试成员');
  await memberPage.getByLabel('设备名称').fill('家人的手机');
  await memberPage.getByRole('button', { name: '申请登录', exact: true }).click();
  await expect(memberPage.getByRole('heading', { name: '等待管理员批准' })).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByText('家人的手机', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(memberPage.getByText('测试成员').first()).toBeVisible();
  const member = await api<Session>(memberPage, '/auth/session');
  await page.goto('/#/overview');
  expect((await api<SyncSnapshot>(memberPage, '/sync/pull')).healthRecords).toHaveLength(0);
  await api(page, `/permissions/${member.user.id}`, 'PUT', { grant: 'view' });
  expect((await api<SyncSnapshot>(memberPage, '/sync/pull')).healthRecords).toHaveLength(1);
  const medication: SyncOperation = {
    operationId: crypto.randomUUID(),
    epoch: initial.epoch,
    resource: 'medication',
    recordId: crypto.randomUUID(),
    baseVersion: 0,
    action: 'upsert',
    data: {
      ownerId: admin.user.id,
      name: '测试药品',
      specification: '测试规格',
      form: '片剂',
      route: '口服',
      reason: '',
      note: '',
      startDate: '2026-01-01',
      endDate: null,
      status: 'active',
      schedules: [
        {
          id: crypto.randomUUID(),
          period: 'morning',
          time: null,
          dose: '0.5',
          unit: '片',
          meal: 'after',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
        },
        {
          id: crypto.randomUUID(),
          period: 'evening',
          time: null,
          dose: '1',
          unit: '片',
          meal: 'after',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
        },
      ],
    },
  };
  await api(page, '/sync/push', 'POST', { operations: [medication] });
  const today = await api<unknown[]>(
    memberPage,
    `/medications/today?date=2026-09-22&ownerId=${admin.user.id}`,
  );
  expect(today).toHaveLength(2);
  await page.reload();
  await expect(page.getByText('测试管理员').first()).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.getByRole('button', { name: '新增健康记录', exact: true }).first().click();
  await page.getByLabel('收缩压').fill('121');
  await page.getByLabel('舒张压').fill('81');
  await page.getByLabel('备注', { exact: true }).fill('离线持久化测试');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('离线持久化测试', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('测试管理员').first()).toBeVisible();
  await expect(page.getByText('离线持久化测试', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect
    .poll(async () => (await api<SyncSnapshot>(page, '/sync/pull')).healthRecords.length, {
      timeout: 20000,
    })
    .toBe(2);
  const backup = await api(page, '/backups/export');
  const preview = await api<{ previewId: string }>(page, '/backups/preview', 'POST', {
    backup,
    mode: 'merge',
  });
  expect(preview.previewId).toBeTruthy();
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.screenshot({ path: '.artifacts/desktop.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      [...document.querySelectorAll('canvas')].every(
        (canvas) => canvas.getBoundingClientRect().right <= window.innerWidth,
      ),
  );
  await page.screenshot({ path: '.artifacts/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const restored = await api<{ epoch: string }>(page, '/backups/restore', 'POST', {
    previewId: preview.previewId,
  });
  expect(restored.epoch).not.toBe(initial.epoch);
  expect((await page.request.get(`${origin}/api/v1/auth/session`)).status()).toBe(401);
  expect((await login(page)).user.id).toBe(admin.user.id);
  const afterMerge = await api<SyncSnapshot>(page, '/sync/pull');
  expect(afterMerge.healthRecords).toHaveLength(2);
  expect(afterMerge.medications).toHaveLength(1);
  const toDelete = afterMerge.healthRecords[0]!;
  await api(page, '/sync/push', 'POST', {
    operations: [
      {
        operationId: crypto.randomUUID(),
        epoch: afterMerge.epoch,
        resource: 'health',
        recordId: toDelete.id,
        baseVersion: toDelete.version,
        action: 'delete',
      },
    ],
  });
  expect(
    (await api<SyncSnapshot>(page, '/sync/pull')).healthRecords.find(
      (record) => record.id === toDelete.id,
    )?.deletedAt,
  ).toBeTruthy();
  const overwrite = await api<{ previewId: string }>(page, '/backups/preview', 'POST', {
    backup,
    mode: 'overwrite',
  });
  await api(page, '/backups/restore', 'POST', { previewId: overwrite.previewId });
  await login(page);
  const afterOverwrite = await api<SyncSnapshot>(page, '/sync/pull');
  expect(afterOverwrite.healthRecords.every((record) => record.deletedAt === null)).toBe(true);
  expect(afterOverwrite.healthRecords.map((record) => record.ownerId)).toEqual(
    afterMerge.healthRecords.map((record) => record.ownerId),
  );
  expect(afterOverwrite.medications[0]?.schedules).toHaveLength(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: '我的健康概览' })).toBeVisible();
  const mobileNavigation = page.getByRole('navigation', { name: '手机导航' });
  await mobileNavigation.getByRole('button', { name: '用药', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用药清单', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加用药', exact: true }).click();
  await page.getByLabel('药品名称', { exact: true }).fill('表单测试药品');
  await page.getByLabel('本次用量', { exact: true }).fill('1');
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '表单测试药品' })).toBeVisible();
  await page.screenshot({ path: '.artifacts/mobile-medication.png', fullPage: true });
  await mobileNavigation.getByRole('button', { name: '家庭', exact: true }).click();
  await expect(page.getByRole('heading', { name: '家庭成员', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await mobileNavigation.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '数据与备份' }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { name: '数据与备份', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '.artifacts/mobile-backup.png', fullPage: true });
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: '已登录设备' })).toBeVisible();
  await page.screenshot({ path: '.artifacts/mobile-devices.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pcContext = await browser.newContext();
  const pcPage = await pcContext.newPage();
  await pcPage.goto('/');
  await pcPage.getByLabel('手机号', { exact: true }).fill('13800000001');
  await pcPage.getByLabel('设备名称').fill('家人的电脑');
  await pcPage.getByRole('button', { name: '申请登录', exact: true }).click();
  await expect(pcPage.getByRole('heading', { name: '等待管理员批准' })).toBeVisible();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(pcPage.getByText('测试成员').first()).toBeVisible();
  await pcPage.goto('/#/settings');
  await pcPage.getByRole('button', { name: '移除', exact: true }).click();
  await pcPage.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(pcPage.getByRole('heading', { name: '手机号登录' })).toBeVisible();
  await pcContext.close();
  await memberContext.close();
});
