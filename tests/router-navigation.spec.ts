import { expect, test } from '@playwright/test';

test('hash 深链接、导航、前进后退与 404', async ({ page }) => {
  await page.goto('/#/profile');
  await expect(page.getByRole('heading', { name: '简历 / 偏好配置' })).toBeVisible();

  await page.getByRole('button', { name: '岗位台账' }).click();
  await expect(page).toHaveURL(/#\/jobs$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/profile$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/jobs$/);

  await page.goto('/#/jobs/jd_import_demo');
  await page.reload();
  await expect(page).toHaveURL(/#\/jobs\/jd_import_demo$/);

  await page.goto('/#/unknown/path');
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
});
