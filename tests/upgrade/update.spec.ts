import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { resolve } from 'node:path';
import type { PendingOperation } from '../../apps/web/src/storage/database';
const origin = 'http://localhost:8899';
const control = 'http://127.0.0.1:8900';
async function deploy(
  request: APIRequestContext,
  version: 'a' | 'b' | 'legacy',
  failedAssets = false,
) {
  const response = await request.post(control, { data: { version, failedAssets } });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{
    a: { version: string; buildId: string };
    b: { version: string; buildId: string };
  }>;
}
async function auth(page: Page) {
  const status = await page.request.get(origin + '/api/v1/auth/status');
  const initialized = (await status.json()).data.initialized;
  const response = await page.request.post(
    origin + '/api/v1/auth/' + (initialized ? 'admin-recover' : 'initialize'),
    {
      headers: { Origin: origin },
      data: {
        phone: '13800000000',
        ...(!initialized ? { nickname: '升级测试成员' } : {}),
        deviceName: '升级测试设备',
        initKey: 'upgrade-only-test-key',
      },
    },
  );
  const result = await response.json();
  expect(result.success, JSON.stringify(result)).toBe(true);
}
async function loaded(page: Page) {
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: '我的账户' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (await page.evaluate(() => !navigator.serviceWorker.controller)) await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await expect(page.getByRole('heading', { name: '我的账户' })).toBeVisible();
}
async function ready(page: Page) {
  await page
    .locator('.settings-section')
    .getByRole('button', { name: '检查更新', exact: true })
    .click();
  await expect(page.locator('.settings-section.update-notice')).toContainText('可以更新了', {
    timeout: 20000,
  });
}
async function buildId(page: Page) {
  return page.locator('.settings-section.update-notice .build-id').textContent();
}
async function outbox(page: Page) {
  return page.evaluate(
    () =>
      new Promise<PendingOperation[]>((resolve, reject) => {
        const open = indexedDB.open('simcare-local-v1');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('outbox').objectStore('outbox').getAll();
          req.onsuccess = () => {
            resolve(req.result);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
      }),
  );
}

test('真实构建升级：数据、登录、字号和多页面保护', async ({ page, context, request }) => {
  const versions = await deploy(request, 'a');
  await auth(page);
  await loaded(page);
  expect(await buildId(page)).toContain(versions.a.buildId);
  const headers = await request.get(origin + '/sw.js');
  expect(headers.headers()['cache-control']).toBe('no-cache');
  expect((await request.get(origin + '/version.json')).headers()['cache-control']).toBe('no-store');
  const deep = await request.get(origin + '/deep/link', {
    headers: { 'Sec-Fetch-Mode': 'navigate' },
  });
  expect(deep.headers()['cache-control']).toMatch(/no-cache|must-revalidate/);
  const asset = (await headers.text()).match(/assets\/[^"']+\.js/)?.[0];
  expect(asset).toBeTruthy();
  expect((await request.get(origin + '/' + asset)).headers()['cache-control']).toContain(
    'immutable',
  );
  await page.getByRole('button', { name: '特大', exact: true }).click();
  // Queue a real offline edit, then keep the API unavailable while downloading the new shell.
  await context.setOffline(true);
  await page.goto('/#/health');
  await page.getByRole('button', { name: '新增记录', exact: true }).click();
  await page.getByLabel('高压（收缩压） · mmHg', { exact: true }).fill('123');
  await page.getByLabel('低压（舒张压） · mmHg', { exact: true }).fill('78');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const pending = await outbox(page);
  expect(pending).toHaveLength(1);
  await context.route('**/api/v1/sync/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: { code: 'TEST_OFFLINE', message: '测试暂停同步' },
      }),
    }),
  );
  await context.setOffline(false);
  await page.goto('/#/settings');
  const cookie = (await context.cookies()).find((item) => item.name === 'simcare_session')?.value;
  expect(cookie).toBeTruthy();
  await deploy(request, 'b');
  await ready(page);
  await page
    .locator('.update-notice:not(.settings-section)')
    .getByRole('button', { name: '稍后', exact: true })
    .click();
  await expect(page.locator('.update-notice:not(.settings-section)')).toHaveCount(0);
  await page.getByLabel('姓名或昵称', { exact: true }).fill('未保存的名字');
  const update = page
    .locator('.settings-section.update-notice')
    .getByRole('button', { name: '立即更新', exact: true });
  await expect(update).toBeDisabled();
  await expect(page.locator('.settings-section.update-notice')).toContainText('保存或取消');
  await page.getByRole('button', { name: '取消修改', exact: true }).click();
  const second = await context.newPage();
  await second.goto('/#/settings');
  await update.click();
  await expect(page.locator('.settings-section.update-notice')).toContainText('关闭其他');
  expect(await buildId(page)).toContain(versions.a.buildId);
  await second.close();
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'test-document-loads',
      String(Number(sessionStorage.getItem('test-document-loads') ?? 0) + 1),
    ),
  );
  await update.click();
  await expect(page.locator('.build-id')).toContainText(versions.b.buildId);
  expect(await page.evaluate(() => sessionStorage.getItem('test-document-loads'))).toBe('1');
  expect(await outbox(page)).toEqual(pending);
  expect((await context.cookies()).find((item) => item.name === 'simcare_session')?.value).toBe(
    cookie,
  );
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'extra');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '我的账户' })).toBeVisible();
  expect(await outbox(page)).toEqual(pending);
  await context.unroute('**/api/v1/sync/**');
  await context.setOffline(false);
  await expect.poll(async () => (await outbox(page)).length).toBe(0);
  const records = await page.request.get(origin + '/api/v1/sync/pull');
  expect(
    (await records.json()).data.healthRecords.some(
      (item: { systolic: number }) => item.systolic === 123,
    ),
  ).toBe(true);
});

test('下载失败保留旧版，重试与部署回退均可更新', async ({ page, request }) => {
  const versions = await deploy(request, 'a');
  await auth(page);
  await loaded(page);
  await deploy(request, 'b', true);
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(page.locator('.settings-section.update-notice')).toContainText(/失败|未完成/, {
    timeout: 20000,
  });
  expect(await buildId(page)).toContain(versions.a.buildId);
  await deploy(request, 'b');
  await ready(page);
  await page
    .locator('.settings-section.update-notice')
    .getByRole('button', { name: '立即更新', exact: true })
    .click();
  await expect(page.locator('.build-id')).toContainText(versions.b.buildId);
  await deploy(request, 'a');
  await ready(page);
  await page
    .locator('.settings-section.update-notice')
    .getByRole('button', { name: '立即更新', exact: true })
    .click();
  await expect(page.locator('.build-id')).toContainText(versions.a.buildId);
});

test('真实 v0.1.1 首次过渡：保留登录和本地数据，关闭所有窗口后接管', async ({
  page,
  context,
  request,
}) => {
  const versions = await deploy(request, 'legacy');
  await auth(page);
  await loaded(page);
  await page.getByRole('button', { name: '特大', exact: true }).click();
  await context.setOffline(true);
  await page.goto('/#/health');
  await page.getByRole('button', { name: '新增记录', exact: true }).click();
  await page.getByLabel('高压（收缩压） · mmHg', { exact: true }).fill('124');
  await page.getByLabel('低压（舒张压） · mmHg', { exact: true }).fill('79');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const before = await outbox(page);
  expect(before).toHaveLength(1);
  await context.route('**/api/v1/sync/**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: { code: 'OFFLINE_TEST', message: '测试暂停同步' },
      }),
    }),
  );
  await context.setOffline(false);
  await page.goto('/#/settings');
  const cookies = await context.cookies();
  await deploy(request, 'b');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });
  await expect
    .poll(() =>
      page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting),
    )
    .toBe(true);
  await expect(page.getByRole('heading', { name: '应用版本与更新' })).toHaveCount(0);
  await page.close();
  const reopened = await context.newPage();
  await loaded(reopened);
  // The legacy worker has no in-app upgrade code; allow its natural lifecycle to finish.
  await reopened.reload();
  await expect(reopened.locator('.build-id')).toContainText(versions.b.buildId);
  expect((await context.cookies()).find((item) => item.name === 'simcare_session')?.value).toBe(
    cookies.find((item) => item.name === 'simcare_session')?.value,
  );
  expect(await outbox(reopened)).toEqual(before);
  await expect(reopened.locator('html')).toHaveAttribute('data-text-size', 'extra');
});

test('冲突记录升级后完整保留，仍可由用户处理', async ({ page, context, request }) => {
  const versions = await deploy(request, 'a');
  await auth(page);
  await loaded(page);
  await context.setOffline(true);
  await page.goto('/#/health');
  await page.getByRole('button', { name: '新增记录', exact: true }).click();
  await page.getByLabel('高压（收缩压） · mmHg', { exact: true }).fill('125');
  await page.getByLabel('低压（舒张压） · mmHg', { exact: true }).fill('80');
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const pending = (await outbox(page))[0]!;
  const collision = await page.request.post(origin + '/api/v1/sync/push', {
    headers: { Origin: origin },
    data: {
      operations: [
        {
          ...pending.operation,
          operationId: crypto.randomUUID(),
          data: { ...pending.operation.data, systolic: 126 },
        },
      ],
    },
  });
  expect((await collision.json()).success).toBe(true);
  await context.setOffline(false);
  await expect.poll(async () => (await outbox(page))[0]?.status).toBe('conflict');
  const before = await outbox(page);
  await page.goto('/#/settings');
  await deploy(request, 'b');
  await ready(page);
  await page
    .locator('.settings-section.update-notice')
    .getByRole('button', { name: '立即更新', exact: true })
    .click();
  await expect(page.locator('.build-id')).toContainText(versions.b.buildId);
  expect(await outbox(page)).toEqual(before);
  await page.locator('.sync-status').click();
  await expect(page.getByRole('dialog')).toContainText('这台手机的记录');
  await expect(page.getByRole('dialog')).toContainText('125');
  await expect(page.getByRole('dialog')).toContainText('126');
  await page.getByRole('button', { name: '采用家人已保存的记录', exact: true }).click();
  await expect.poll(async () => (await outbox(page)).length).toBe(0);
});

test('表单、正在保存和备份生成保护，以及大字更新布局', async ({ page, context, request }) => {
  await deploy(request, 'a');
  await auth(page);
  await loaded(page);
  await deploy(request, 'b');
  await ready(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: '特大', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/#/health');
  await page.getByRole('button', { name: '新增记录', exact: true }).click();
  await page.getByLabel('高压（收缩压） · mmHg', { exact: true }).fill('121');
  await expect(
    page.locator('.update-notice').getByRole('button', { name: '立即更新', exact: true }),
  ).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/#/settings');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route('**/api/v1/members/*', async (route) => {
    if (route.request().method() === 'PATCH') await pending;
    await route.continue();
  });
  await page.getByLabel('姓名或昵称', { exact: true }).fill('已保存的升级测试成员');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.settings-section.update-notice')).toContainText('正在保存');
  await expect(
    page
      .locator('.settings-section.update-notice')
      .getByRole('button', { name: '立即更新', exact: true }),
  ).toBeDisabled();
  release();
  await expect(page.getByRole('button', { name: '取消修改', exact: true })).toHaveCount(0);
  await context.unroute('**/api/v1/members/*');
  await page.goto('/#/backup');
  await page.getByLabel('备份密码', { exact: true }).first().fill('upgrade-test-password');
  await expect(
    page.locator('.update-notice').getByRole('button', { name: '立即更新', exact: true }),
  ).toBeDisabled();
  let releaseBackup!: () => void;
  const pendingBackup = new Promise<void>((resolve) => {
    releaseBackup = resolve;
  });
  await context.route('**/api/v1/backups/export', async (route) => {
    await pendingBackup;
    await route.continue();
  });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载加密备份', exact: true }).click();
  await expect(page.locator('.update-notice')).toContainText('正在保存、同步或处理数据');
  await expect(
    page.locator('.update-notice').getByRole('button', { name: '立即更新', exact: true }),
  ).toBeDisabled();
  releaseBackup();
  const backup = await download;
  const backupFile = resolve('.artifacts', 'update-restore-test.simcare');
  await backup.saveAs(backupFile);
  await expect(
    page.locator('.update-notice').getByRole('button', { name: '立即更新', exact: true }),
  ).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles(backupFile);
  await page.getByLabel('备份密码', { exact: true }).nth(1).fill('upgrade-test-password');
  await page.getByRole('button', { name: '校验并预览', exact: true }).click();
  await expect(page.locator('.restore-preview')).toBeVisible();
  let releaseRestore!: () => void;
  const pendingRestore = new Promise<void>((resolve) => {
    releaseRestore = resolve;
  });
  await context.route('**/api/v1/backups/restore', async (route) => {
    await pendingRestore;
    await route.continue();
  });
  await page.getByRole('button', { name: '确认合并恢复', exact: true }).click();
  await page.getByRole('button', { name: '执行恢复', exact: true }).click();
  await expect(page.locator('.update-notice')).toContainText('正在保存、同步或处理数据');
  await expect(
    page.locator('.update-notice').getByRole('button', { name: '立即更新', exact: true }),
  ).toBeDisabled();
  releaseRestore();
  await expect(page.getByRole('heading', { name: '手机号登录', exact: true })).toBeVisible();
});
