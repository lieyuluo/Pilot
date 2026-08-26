import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
});

test("用户可以完成一个本地演示批次并查看职位快照", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("成功沟通最短间隔（毫秒）").fill("0");
  await page.getByRole("button", { name: "保存设置" }).click();

  await page.getByRole("button", { name: "搜索方案", exact: true }).click();
  await page.getByRole("checkbox", { name: /启用此方案/ }).check();
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await page.getByRole("button", { name: "开场模板", exact: true }).click();
  await page.getByRole("checkbox", { name: /启用此模板/ }).check();
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await page.getByRole("button", { name: "总览", exact: true }).click();
  await page.getByRole("button", { name: "启动批次", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "沟通额度 20 个 / 检查 200 个",
  );
  await page.getByRole("button", { name: "开始批次", exact: true }).click();
  await expect(page.locator(".operation-state strong")).toHaveText("已完成", {
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "职位快照", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("沟通成功");
  await expect(page.getByRole("table")).toContainText("已排除");
  await expect(page.getByRole("table")).toContainText("城市不符合方案");
  await expect(page.getByRole("table")).toContainText("职位关键词不匹配");
  await expect(page.getByRole("table")).toContainText("Go 后端开发工程师");
});

test("设置页通过扩展配对、页面连接完成只读校准", async ({ page }) => {
  const extensionStatus = {
    pairingState: "等待批准",
    connectionState: "扩展已连接",
    capabilities: ["read"],
    readOnlyCalibrated: false,
    pendingPairing: { requestId: "pairing-1", code: "482731" },
  } as {
    pairingState: string;
    connectionState: string;
    capabilities: string[];
    readOnlyCalibrated: boolean;
    pendingPairing?: { requestId: string; code: string };
    page?: { tabId: number; url: string; active: boolean; visible: boolean };
  };
  let approvalRequests = 0;
  let checkRequests = 0;
  await page.route("**/api/extension/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(extensionStatus),
    });
  });
  await page.route(
    "**/api/extension/pairings/pairing-1/approve",
    async (route) => {
      approvalRequests += 1;
      extensionStatus.pairingState = "已配对";
      delete extensionStatus.pendingPairing;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ paired: true }),
      });
    },
  );
  await page.route("**/api/calibration/boss", async (route) => {
    checkRequests += 1;
    extensionStatus.readOnlyCalibrated = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ calibrated: true, candidatesRecognized: 12 }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText("482731", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "批准此扩展", exact: true }).click();
  await expect(page.getByText(/扩展已配对。请在已登录/)).toBeVisible();
  expect(approvalRequests).toBe(1);
  extensionStatus.connectionState = "页面已连接";
  extensionStatus.page = {
    tabId: 17,
    url: "https://www.zhipin.com/web/geek/job",
    active: true,
    visible: true,
  };
  await expect(page.getByText("已连接 BOSS 页面", { exact: true })).toBeVisible(
    {
      timeout: 5_000,
    },
  );
  await page.getByRole("button", { name: "校准页面读取", exact: true }).click();
  await expect(
    page.getByText("只读校准通过，识别到 12 个候选职位。"),
  ).toBeVisible();
  expect(checkRequests).toBe(1);
  await expect(page.getByLabel(/只读校准已经通过/)).toBeChecked();
  await expect(page.getByLabel(/扩展支持原子批次发送/)).toBeDisabled();
});
