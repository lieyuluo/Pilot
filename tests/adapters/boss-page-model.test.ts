import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { BossPageModel } from "../../src/adapters/boss/page-model.ts";

describe("BossPageModel", () => {
  it("从本地职位列表夹具读取候选职位", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(
        pathToFileURL(join(process.cwd(), "tests/fixtures/boss/job-list.html"))
          .href,
      );

      const candidates = await new BossPageModel(page).listCandidates();

      expect(candidates).toEqual([
        expect.objectContaining({
          id: "abc123",
          title: "Go 后端开发工程师",
          company: "远山云计算",
          city: "北京",
          region: "海淀区",
          salaryMinK: 25,
          salaryMaxK: 40,
          experienceMinYears: 3,
          education: "本科",
          industry: "计算机软件",
        }),
        expect.objectContaining({
          id: "def456",
          experienceMinYears: 0,
          education: "硕士",
        }),
      ]);
      expect(candidates[1]).not.toHaveProperty("salaryMinK");
    } finally {
      await browser.close();
    }
  });

  it("只在本地详情夹具确认消息已经出现在聊天区后报告成功", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(
        pathToFileURL(
          join(process.cwd(), "tests/fixtures/boss/job-detail.html"),
        ).href,
      );
      const model = new BossPageModel(page);

      expect(await model.currentContactState()).toBe("可沟通");
      expect(await model.sendOpening("您好，我想进一步了解这个职位。")).toBe(
        "已确认",
      );
      expect(await model.currentContactState()).toBe("已沟通");
    } finally {
      await browser.close();
    }
  });
});
