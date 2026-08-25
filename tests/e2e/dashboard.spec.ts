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
    "成功沟通 20 个 / 检查 200 个",
  );
  await page.getByRole("button", { name: "确认并启动", exact: true }).click();
  await expect(page.locator(".operation-state strong")).toHaveText("已完成", {
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "职位快照", exact: true }).click();
  await expect(page.getByRole("table")).toContainText("沟通成功");
  await expect(page.getByRole("table")).toContainText("已排除");
  await expect(page.getByRole("table")).toContainText("Go 后端开发工程师");
});
