import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import {
  HumanTakeoverRequired,
  type PlatformAdapter,
  type PlatformContactState,
  type SendOpeningResult,
} from "../../core/batch-runner.ts";
import type { SearchPlan } from "../../core/config.ts";
import type { CandidatePosition } from "../../core/rules.ts";
import { BossPageModel } from "./page-model.ts";

export interface BossAdapterOptions {
  userDataDir: string;
  evidenceDir: string;
  realSendEnabled: () => boolean;
}

export interface BossAdapter extends PlatformAdapter {
  calibrate(plan: SearchPlan): Promise<{ candidatesRecognized: number }>;
}

export function createBossAdapter(options: BossAdapterOptions): BossAdapter {
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  const ensurePage = async (): Promise<Page> => {
    if (context === undefined) {
      mkdirSync(options.userDataDir, { recursive: true });
      context = await chromium.launchPersistentContext(options.userDataDir, {
        headless: false,
        viewport: null,
        locale: "zh-CN",
      });
      context.on("close", () => {
        context = undefined;
        page = undefined;
      });
    }
    page ??= context.pages()[0] ?? (await context.newPage());
    return page;
  };

  return {
    async calibrate(plan) {
      const activePage = await ensurePage();
      await openSearch(activePage, plan);
      const candidates = await new BossPageModel(activePage).listCandidates();
      if (candidates.length === 0) {
        throw await takeover(
          activePage,
          options.evidenceDir,
          "未识别到受支持的职位列表结构",
          "unsupported-page",
        );
      }
      return { candidatesRecognized: candidates.length };
    },
    async *scan(plan: SearchPlan) {
      const activePage = await ensurePage();
      await openSearch(activePage, plan);
      for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const candidates = await new BossPageModel(activePage).listCandidates();
        if (candidates.length === 0) {
          throw await takeover(
            activePage,
            options.evidenceDir,
            "未识别到受支持的职位列表结构",
            "unsupported-page",
          );
        }
        for (const candidate of candidates) {
          yield candidate;
        }
        const next = activePage
          .getByRole("button", { name: /下一页/ })
          .or(activePage.getByRole("link", { name: /下一页/ }));
        if ((await next.count()) === 0 || !(await next.first().isEnabled())) {
          break;
        }
        await next.first().click();
        await activePage.waitForTimeout(800);
        await assertSupportedPage(activePage);
      }
    },
    async currentContactState(candidate): Promise<PlatformContactState> {
      const activePage = await ensurePage();
      if (candidate.url === undefined) {
        return "未知状态";
      }
      const url = new URL(candidate.url, "https://www.zhipin.com");
      if (!isBossHostname(url.hostname)) {
        throw new HumanTakeoverRequired(
          "职位链接跳转到非 Boss 域名",
          "unsupported-page",
        );
      }
      await activePage.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await assertSupportedPage(activePage);
      const state = await new BossPageModel(activePage).currentContactState();
      if (state === "未知状态") {
        await saveEvidence(
          activePage,
          options.evidenceDir,
          "unknown-contact-state",
        );
      }
      return state;
    },
    async sendOpening(
      _candidate: CandidatePosition,
      message: string,
    ): Promise<SendOpeningResult> {
      if (!options.realSendEnabled()) {
        return "明确失败";
      }
      const activePage = await ensurePage();
      await assertSupportedPage(activePage);
      const result = await new BossPageModel(activePage).sendOpening(message);
      if (result !== "已确认") {
        await saveEvidence(
          activePage,
          options.evidenceDir,
          "send-not-confirmed",
        );
      }
      return result;
    },
    async emergencyStop() {
      await context?.close();
    },
  };
}

async function openSearch(page: Page, plan: SearchPlan): Promise<void> {
  const keyword = plan.rules.titleKeywords[0] ?? "";
  const searchUrl = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}`;
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await assertSupportedPage(page);
}

async function assertSupportedPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  if (!isBossHostname(url.hostname)) {
    throw new HumanTakeoverRequired(
      "浏览器离开 Boss 官方域名",
      "unsupported-page",
    );
  }
  const body = await page
    .locator("body")
    .innerText({ timeout: 10_000 })
    .catch(() => "");
  if (
    /登录|扫码登录|手机号登录/.test(body) &&
    /登录/.test(url.pathname + body.slice(0, 500))
  ) {
    throw new HumanTakeoverRequired(
      "登录状态已失效，请在专用浏览器中手动登录",
      "login",
    );
  }
  if (/验证码|安全验证|访问异常|完成验证|滑块/.test(body)) {
    throw new HumanTakeoverRequired(
      "平台要求安全验证，自动流程已经停止",
      "verification",
    );
  }
}

function isBossHostname(hostname: string): boolean {
  return hostname === "zhipin.com" || hostname.endsWith(".zhipin.com");
}

async function takeover(
  page: Page,
  evidenceDir: string,
  message: string,
  kind: HumanTakeoverRequired["kind"],
): Promise<HumanTakeoverRequired> {
  await saveEvidence(page, evidenceDir, kind);
  return new HumanTakeoverRequired(message, kind);
}

async function saveEvidence(
  page: Page,
  evidenceDir: string,
  reason: string,
): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  await page
    .screenshot({
      path: join(evidenceDir, `${timestamp}-${reason}.png`),
      fullPage: false,
    })
    .catch(() => undefined);
}
