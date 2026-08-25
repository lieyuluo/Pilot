import type { Locator, Page } from "playwright";

import type {
  PlatformContactState,
  SendOpeningResult,
} from "../../core/batch-runner.ts";
import type { CandidatePosition, EducationLevel } from "../../core/rules.ts";

const CARD_SELECTOR = ".job-card-wrapper, .job-card-box, [data-jobid]";

export class BossPageModel {
  constructor(private readonly page: Page) {}

  async listCandidates(): Promise<CandidatePosition[]> {
    const cards = this.page.locator(CARD_SELECTOR);
    const count = await cards.count();
    const candidates: CandidatePosition[] = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = await this.readCard(cards.nth(index));
      if (candidate !== undefined) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  async currentContactState(): Promise<PlatformContactState> {
    const continueControl = this.page
      .getByRole("button", { name: /继续沟通/ })
      .or(this.page.getByRole("link", { name: /继续沟通/ }));
    if ((await continueControl.count()) > 0) {
      return "已沟通";
    }
    const messages = this.page.locator(
      '.message-list > *, [class*="message-list"] [class*="message-item"]',
    );
    if ((await messages.count()) > 0) {
      return "已沟通";
    }
    const startControl = this.page
      .getByRole("button", { name: /立即沟通|打招呼/ })
      .or(this.page.getByRole("link", { name: /立即沟通|打招呼/ }));
    return (await startControl.count()) > 0 ? "可沟通" : "未知状态";
  }

  async sendOpening(message: string): Promise<SendOpeningResult> {
    const startControl = this.page
      .getByRole("button", { name: /立即沟通|打招呼/ })
      .or(this.page.getByRole("link", { name: /立即沟通|打招呼/ }));
    if ((await startControl.count()) === 0) {
      return "明确失败";
    }
    try {
      await startControl.first().click();
      const input = this.page.getByRole("textbox").last();
      await input.waitFor({ state: "visible", timeout: 8_000 });
      await input.fill(message);
      const sendControl = this.page
        .getByRole("button", { name: /^发送$/ })
        .or(this.page.getByText(/^发送$/, { exact: true }));
      if ((await sendControl.count()) === 0) {
        return "结果未知";
      }
      await sendControl.first().click();
      await this.page
        .getByText(message, { exact: true })
        .last()
        .waitFor({ state: "visible", timeout: 8_000 });
      return "已确认";
    } catch {
      return "结果未知";
    }
  }

  private async readCard(
    card: Locator,
  ): Promise<CandidatePosition | undefined> {
    const title = await optionalText(
      card.locator('.job-name, [class*="job-name"]').first(),
    );
    const company = await optionalText(
      card.locator('.company-name, [class*="company-name"]').first(),
    );
    if (title === undefined || company === undefined) {
      return undefined;
    }

    const link = card.locator('a[href*="/job_detail/"]').first();
    const url = (await link.getAttribute("href")) ?? undefined;
    const id = url?.match(/\/job_detail\/([^./?]+)(?:\.html)?/)?.[1];
    const salaryText = await optionalText(
      card.locator('.salary, [class*="salary"]').first(),
    );
    const salary = parseSalary(salaryText);
    const areaText = await optionalText(
      card.locator('.job-area, [class*="job-area"]').first(),
    );
    const [city, region] =
      areaText?.split(/[·・]/).map((part) => part.trim()) ?? [];
    const tags = await card
      .locator('.tag-list li, [class*="tag-list"] li')
      .allTextContents();
    const companyTags = await card
      .locator('.company-tag-list li, [class*="company-tag"] li')
      .allTextContents();
    const education = tags
      .map(parseEducation)
      .find((value) => value !== undefined);
    const experienceMinYears = parseExperience(tags);

    return {
      ...(id === undefined ? {} : { id }),
      ...(url === undefined ? {} : { url }),
      title,
      company,
      ...(city === undefined || city === "" ? {} : { city }),
      ...(region === undefined || region === "" ? {} : { region }),
      ...salary,
      ...(experienceMinYears === undefined ? {} : { experienceMinYears }),
      ...(education === undefined ? {} : { education }),
      ...(companyTags[0]?.trim() ? { industry: companyTags[0].trim() } : {}),
      ...(title.includes("远程") || areaText?.includes("远程")
        ? { remote: true }
        : {}),
    };
  }
}

async function optionalText(locator: Locator): Promise<string | undefined> {
  if ((await locator.count()) === 0) {
    return undefined;
  }
  const value = (await locator.textContent())?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function parseSalary(
  value: string | undefined,
): Pick<CandidatePosition, "salaryMinK" | "salaryMaxK"> {
  const match = value?.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*K/i);
  if (match?.[1] === undefined || match[2] === undefined) {
    return {};
  }
  return { salaryMinK: Number(match[1]), salaryMaxK: Number(match[2]) };
}

function parseExperience(tags: string[]): number | undefined {
  for (const tag of tags) {
    if (/经验不限|应届生|在校生/.test(tag)) {
      return 0;
    }
    const match = tag.match(/(\d+)\s*[-–—]\s*\d+\s*年/);
    if (match?.[1] !== undefined) {
      return Number(match[1]);
    }
    const minimum = tag.match(/(\d+)\s*年以上/);
    if (minimum?.[1] !== undefined) {
      return Number(minimum[1]);
    }
  }
  return undefined;
}

function parseEducation(value: string): EducationLevel | undefined {
  if (/学历不限/.test(value) || value.trim() === "不限") {
    return "不限";
  }
  const levels: EducationLevel[] = [
    "博士",
    "硕士",
    "本科",
    "大专",
    "中专/高中",
  ];
  return levels.find((level) => value.includes(level));
}
