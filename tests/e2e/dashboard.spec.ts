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

test("设置页同步展示扩展的一键页面准备状态", async ({ page }) => {
  const extensionStatus = {
    pairingState: "等待授权",
    connectionState: "扩展已连接",
    capabilities: ["read", "batch-send"],
    readOnlyCalibrated: false,
    preparation: {
      state: "running",
      stage: "calibrating",
      message: "正在检查页面…",
    },
  } as {
    pairingState: string;
    connectionState: string;
    capabilities: string[];
    readOnlyCalibrated: boolean;
    preparation: {
      state: string;
      stage: string;
      message: string;
      warning?: string;
    };
    page?: { tabId: number; url: string; active: boolean; visible: boolean };
  };
  await page.route("**/api/extension/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(extensionStatus),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByText("正在检查页面…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准此扩展" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "校准页面读取" })).toHaveCount(
    0,
  );
  extensionStatus.pairingState = "已授权";
  extensionStatus.connectionState = "页面已连接";
  extensionStatus.readOnlyCalibrated = true;
  extensionStatus.preparation = {
    state: "ready",
    stage: "ready",
    message: "页面已就绪，识别到 12 个候选职位",
  };
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
  await expect(
    page.getByText("页面已就绪，识别到 12 个候选职位"),
  ).toBeVisible();
  await expect(page.getByLabel(/当前页面已经就绪/)).toBeChecked();
  await expect(page.getByLabel(/扩展支持原子批次发送/)).toBeDisabled();
});
