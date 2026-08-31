import type { CandidatePosition, EducationLevel } from "../core/rules.ts";
import type { PlatformContactState } from "../core/batch-runner.ts";

const CARD_SELECTOR = ".job-card-wrapper, .job-card-box, [data-jobid]";
const CHAT_MESSAGE_SELECTOR =
  '.message-list > *, [class*="message-list"] [class*="message-item"]';

export type BossPageKind =
  "login" | "verification" | "list" | "detail" | "unsupported";

export interface BossPageInspection {
  kind: BossPageKind;
  url: string;
  accountDisplayName?: string;
  candidatesRecognized: number;
}

export function inspectBossPage(
  document: Document,
  url: string,
): BossPageInspection {
  const body = document.body?.innerText ?? document.body?.textContent ?? "";
  const accountDisplayName = optionalText(
    document.querySelector(
      '.user-name, [class*="user-name"], .nav-figure .name, [class*="user-info"] [class*="name"]',
    ),
  );
  if (/验证码|安全验证|访问异常|完成验证|滑块/.test(body)) {
    return inspection("verification");
  }
  if (/扫码登录|手机号登录|密码登录/.test(body)) {
    return inspection("login");
  }
  const candidatesRecognized = document.querySelectorAll(CARD_SELECTOR).length;
  if (candidatesRecognized > 0) return inspection("list");
  if (
    /\/job_detail\//.test(safePathname(url)) ||
    document.querySelector(
      '.job-detail-box, [class*="job-detail"], [class*="job-banner"]',
    ) !== null
  ) {
    return inspection("detail");
  }
  return inspection("unsupported");

  function inspection(kind: BossPageKind): BossPageInspection {
    return {
      kind,
      url,
      ...(accountDisplayName === undefined ? {} : { accountDisplayName }),
      candidatesRecognized:
        kind === "list" ? document.querySelectorAll(CARD_SELECTOR).length : 0,
    };
  }
}

export function readCandidates(
  document: Document,
  baseUrl: string,
): CandidatePosition[] {
  return [...document.querySelectorAll<HTMLElement>(CARD_SELECTOR)]
    .map((card) => readCard(card, baseUrl))
    .filter(
      (candidate): candidate is CandidatePosition => candidate !== undefined,
    );
}

export function readContactState(document: Document): PlatformContactState {
  const controls = [...document.querySelectorAll<HTMLElement>("button, a")];
  if (controls.some((control) => /继续沟通/.test(textOf(control)))) {
    return "平台已沟通";
  }
  if (document.querySelector(CHAT_MESSAGE_SELECTOR) !== null) {
    return "平台已沟通";
  }
  return controls.some((control) => /立即沟通|打招呼/.test(textOf(control)))
    ? "可沟通"
    : "未知状态";
}

export function readCurrentCandidate(
  document: Document,
  url: string,
  fallback?: CandidatePosition,
): CandidatePosition | undefined {
  const title =
    optionalText(
      document.querySelector(
        '.job-name, .job-detail-box h1, [class*="job-detail"] h1, [class*="job-banner"] h1',
      ),
    ) ?? fallback?.title;
  const company =
    optionalText(
      document.querySelector(
        '.company-name, [class*="company-name"], [class*="company-info"] h2',
      ),
    ) ?? fallback?.company;
  if (title === undefined || company === undefined) return undefined;
  const normalizedUrl = normalizeBossUrl(url, url);
  const id = normalizedUrl?.match(/\/job_detail\/([^./?]+)(?:\.html)?/)?.[1];
  const body = document.body?.innerText ?? document.body?.textContent ?? "";
  const salary = parseSalary(
    optionalText(document.querySelector('.salary, [class*="salary"]')),
  );
  return {
    ...(fallback ?? {}),
    ...(id === undefined ? {} : { id }),
    ...(normalizedUrl === undefined ? {} : { url: normalizedUrl }),
    title,
    company,
    ...salary,
    ...(body.includes("远程") ? { remote: true } : {}),
  };
}

export interface DomSendOpeningResult {
  result: "沟通成功" | "结果未知" | "明确未开始" | "内容不符";
  irreversibleStarted: boolean;
  baselineOutgoingCount: number;
  finalOutgoingCount: number;
  confirmation?: "matched-message" | "boss-success-dialog";
  error?: string;
}

export interface DomAppendOpeningResult {
  completed: boolean;
  error?: string;
}

export async function appendOpeningTemplateFromDocument(
  document: Document,
  message: string,
  timeoutMs = 5_000,
): Promise<DomAppendOpeningResult> {
  const existing = outgoingMessages(document);
  if (
    existing.some(
      (text) => normalizeMessage(text) === normalizeMessage(message),
    )
  ) {
    return { completed: true };
  }
  if (timeoutMs <= 0) {
    return { completed: false, error: "开场模板续作已经过期" };
  }

  const deadline = Date.now() + timeoutMs;
  const composer = await waitForOptional(
    () => findChatComposer(document),
    remainingTime(),
  );
  if (composer === undefined) {
    return { completed: false, error: "聊天输入框暂不可用" };
  }
  if (Date.now() >= deadline) {
    return { completed: false, error: "开场模板续作已经过期" };
  }

  setComposerValue(composer, message);
  if (normalizeMessage(composerText(composer)) !== normalizeMessage(message)) {
    return { completed: false, error: "消息输入框未接受完整开场消息" };
  }

  const sendButton = await waitForOptional(
    () => findSendButton(composer),
    Math.min(1_500, remainingTime()),
  );
  if (sendButton === undefined) {
    return { completed: false, error: "没有找到可用的聊天发送按钮" };
  }
  if (Date.now() >= deadline) {
    return { completed: false, error: "开场模板续作已经过期" };
  }

  sendButton.click();
  const created = await waitForOptional(() => {
    const messages = outgoingMessages(document).slice(existing.length);
    return messages.length > 0 ? messages : undefined;
  }, remainingTime());
  if (created === undefined) {
    return { completed: false, error: "点击发送后未能确认新增的本人消息" };
  }
  if (
    created.some((text) => normalizeMessage(text) === normalizeMessage(message))
  ) {
    return { completed: true };
  }
  return { completed: false, error: "新增本人消息与开场消息不一致" };

  function remainingTime(): number {
    return Math.max(1, deadline - Date.now());
  }
}

export async function sendOpeningFromDocument(
  document: Document,
  message: string,
  timeoutMs = 10_000,
  onSuccessReceipt?: (result: DomSendOpeningResult) => void,
): Promise<DomSendOpeningResult> {
  const baseline = outgoingMessages(document);
  const deadline = Date.now() + timeoutMs;
  const contact = [...document.querySelectorAll<HTMLElement>("button, a")].find(
    (element) =>
      isElementAvailable(element) && /立即沟通|打招呼/.test(textOf(element)),
  );
  if (contact === undefined) {
    return result("明确未开始", false, "没有找到可用的沟通入口");
  }

  contact.click();
  const irreversibleStarted = true;
  try {
    const signal = await waitFor(() => {
      const successDialog = findBossSuccessDialog(document);
      if (successDialog !== undefined) {
        return { kind: "success-dialog" as const, dialog: successDialog };
      }
      const created = outgoingMessages(document).slice(baseline.length);
      if (created.length > 0) {
        return { kind: "outgoing-messages" as const, messages: created };
      }
      const composer = findChatComposer(document);
      return composer === undefined
        ? undefined
        : { kind: "composer" as const, composer };
    }, remainingTime());

    if (signal.kind === "success-dialog") {
      return await continueFromSuccessDialog(signal.dialog);
    }
    if (signal.kind === "outgoing-messages") {
      if (
        signal.messages.some(
          (text) => normalizeMessage(text) === normalizeMessage(message),
        )
      ) {
        return result(
          "沟通成功",
          irreversibleStarted,
          undefined,
          "matched-message",
        );
      }
      const delayedDialog = await waitForOptional(
        () => findBossSuccessDialog(document),
        Math.min(500, remainingTime()),
      );
      if (delayedDialog !== undefined) {
        return await continueFromSuccessDialog(delayedDialog);
      }
      return result(
        "内容不符",
        irreversibleStarted,
        "平台自动产生了不同内容的消息",
      );
    }

    return await sendAndConfirm(signal.composer, baseline.length, false);
  } catch (error) {
    const successDialog = findBossSuccessDialog(document);
    if (successDialog !== undefined) {
      return result(
        "沟通成功",
        irreversibleStarted,
        "已确认平台成功回执，但未能继续发送开场模板",
        "boss-success-dialog",
      );
    }
    return result(
      "结果未知",
      irreversibleStarted,
      error instanceof Error ? error.message : "页面发送结果无法确认",
    );
  }

  async function continueFromSuccessDialog(
    dialog: HTMLElement,
  ): Promise<DomSendOpeningResult> {
    const confirmedResult = result(
      "沟通成功",
      irreversibleStarted,
      undefined,
      "boss-success-dialog",
    );
    try {
      onSuccessReceipt?.(confirmedResult);
    } catch {
      // The receipt is already conclusive; a notification failure cannot revoke it.
    }
    try {
      const continueButton = findContinueChatControl(dialog);
      if (continueButton === undefined) {
        return result(
          "沟通成功",
          irreversibleStarted,
          "已确认平台成功回执，但没有找到“继续沟通”入口",
          "boss-success-dialog",
        );
      }

      continueButton.click();
      const templateBaselineCount = outgoingMessages(document).length;
      const composer = await waitForOptional(
        () => findChatComposer(document),
        Math.min(5_000, remainingTime()),
      );
      if (composer === undefined) {
        return result(
          "沟通成功",
          irreversibleStarted,
          "已确认平台成功回执，但聊天输入框暂不可用",
          "boss-success-dialog",
        );
      }
      return await sendAndConfirm(composer, templateBaselineCount, true);
    } catch {
      return result(
        "沟通成功",
        irreversibleStarted,
        "已确认平台成功回执，但未能继续发送开场模板",
        "boss-success-dialog",
      );
    }
  }

  async function sendAndConfirm(
    composer: HTMLElement,
    outgoingBaselineCount: number,
    dialogAlreadyConfirmed: boolean,
  ): Promise<DomSendOpeningResult> {
    setComposerValue(composer, message);
    if (
      normalizeMessage(composerText(composer)) !== normalizeMessage(message)
    ) {
      return result(
        dialogAlreadyConfirmed ? "沟通成功" : "结果未知",
        irreversibleStarted,
        "消息输入框未接受完整开场消息",
        dialogAlreadyConfirmed ? "boss-success-dialog" : undefined,
      );
    }
    const sendButton = await waitForOptional(
      () => findSendButton(composer),
      Math.min(1_500, remainingTime()),
    );
    if (sendButton === undefined) {
      return result(
        dialogAlreadyConfirmed ? "沟通成功" : "结果未知",
        irreversibleStarted,
        "没有找到可用的聊天发送按钮",
        dialogAlreadyConfirmed ? "boss-success-dialog" : undefined,
      );
    }
    sendButton.click();
    const created = await waitForOptional(() => {
      const messages = outgoingMessages(document).slice(outgoingBaselineCount);
      return messages.length > 0 ? messages : undefined;
    }, remainingTime());
    if (created === undefined) {
      return result(
        dialogAlreadyConfirmed ? "沟通成功" : "结果未知",
        irreversibleStarted,
        "点击发送后未能确认新增的本人消息",
        dialogAlreadyConfirmed ? "boss-success-dialog" : undefined,
      );
    }
    const matched = created.some(
      (text) => normalizeMessage(text) === normalizeMessage(message),
    );
    if (matched) {
      return result(
        "沟通成功",
        irreversibleStarted,
        undefined,
        "matched-message",
      );
    }
    return result(
      dialogAlreadyConfirmed ? "沟通成功" : "内容不符",
      irreversibleStarted,
      "新增本人消息与开场消息不一致",
      dialogAlreadyConfirmed ? "boss-success-dialog" : undefined,
    );
  }

  function remainingTime(): number {
    return Math.max(1, deadline - Date.now());
  }

  function result(
    value: DomSendOpeningResult["result"],
    started: boolean,
    error?: string,
    confirmation?: DomSendOpeningResult["confirmation"],
  ): DomSendOpeningResult {
    return {
      result: value,
      irreversibleStarted: started,
      baselineOutgoingCount: baseline.length,
      finalOutgoingCount: outgoingMessages(document).length,
      ...(confirmation === undefined ? {} : { confirmation }),
      ...(error === undefined ? {} : { error }),
    };
  }
}

function findBossSuccessDialog(document: Document): HTMLElement | undefined {
  const titleSeeds = exactTextContainers(document, "已向BOSS发送消息").filter(
    isElementAvailable,
  );
  const matches = ancestorCandidates(titleSeeds).filter(
    (element) => isDialogCandidate(element) && hasBossSuccessReceipt(element),
  );
  return (
    matches.find(hasSuccessDialogAction) ??
    matches.find(isSemanticDialogCandidate)
  );
}

function exactTextContainers(
  document: Document,
  expected: string,
): HTMLElement[] {
  const matches: HTMLElement[] = [];
  const walker = document.createTreeWalker(
    document.body,
    4 /* NodeFilter.SHOW_TEXT */,
  );
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (compactText(node.textContent ?? "") !== expected) continue;
    if (node.parentElement !== null) matches.push(node.parentElement);
  }
  return [...new Set(matches)];
}

function ancestorCandidates(seeds: HTMLElement[]): HTMLElement[] {
  return [
    ...new Set(
      seeds.flatMap((seed) => {
        const ancestors: HTMLElement[] = [];
        for (
          let current: HTMLElement | null = seed;
          current !== null &&
          current !== current.ownerDocument.body &&
          current !== current.ownerDocument.documentElement;
          current = current.parentElement
        ) {
          ancestors.push(current);
        }
        return ancestors;
      }),
    ),
  ].sort(
    (left, right) =>
      left.querySelectorAll("*").length - right.querySelectorAll("*").length,
  );
}

function isDialogCandidate(element: HTMLElement): boolean {
  if (
    element === element.ownerDocument.body ||
    element === element.ownerDocument.documentElement ||
    !isElementAvailable(element)
  ) {
    return false;
  }
  if (
    element.getAttribute("role") === "dialog" ||
    element.getAttribute("aria-modal") === "true"
  ) {
    return true;
  }
  const hint = `${element.id} ${element.className}`.toLowerCase();
  return /dialog|modal|greet|expect|popup|popper|layer/.test(hint);
}

function isSemanticDialogCandidate(element: HTMLElement): boolean {
  if (
    element.getAttribute("role") === "dialog" ||
    element.getAttribute("aria-modal") === "true"
  ) {
    return true;
  }
  const hint = `${element.id} ${element.className}`.toLowerCase();
  return /dialog|modal/.test(hint);
}

function hasBossSuccessReceipt(element: HTMLElement): boolean {
  const text = compactText(textOf(element));
  return (
    exactTextContainers(element.ownerDocument, "已向BOSS发送消息").some(
      (title) => title === element || element.contains(title),
    ) &&
    (/设置(?:打)?招呼语/.test(text) || hasSuccessDialogAction(element))
  );
}

function hasSuccessDialogAction(element: HTMLElement): boolean {
  return ["留在此页", "留在此页继续沟通", "继续沟通"].some(
    (label) => findExactTextAction(element, label) !== undefined,
  );
}

function findContinueChatControl(
  element: HTMLElement,
): HTMLElement | undefined {
  return (
    findExactTextAction(element, "继续沟通") ??
    findExactTextAction(element, "留在此页继续沟通") ??
    findExactTextAction(element, "留在此页")
  );
}

function findExactTextAction(
  element: HTMLElement,
  expected: string,
): HTMLElement | undefined {
  const interactive = [
    ...element.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], input[type="button"], input[type="submit"]',
    ),
  ].find(
    (control) =>
      isElementAvailable(control) && actionText(control) === expected,
  );
  if (interactive !== undefined) return interactive;

  return [...element.querySelectorAll<HTMLElement>("*")]
    .filter(
      (control) =>
        isElementAvailable(control) && actionText(control) === expected,
    )
    .sort(
      (left, right) =>
        left.querySelectorAll("*").length - right.querySelectorAll("*").length,
    )[0];
}

function actionText(element: HTMLElement): string {
  const value =
    element.tagName === "INPUT"
      ? (element.getAttribute("value") ?? element.getAttribute("aria-label"))
      : textOf(element);
  return compactText(value ?? "");
}

function findChatComposer(document: Document): HTMLElement | undefined {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'textarea, [contenteditable="true"], input[type="text"]',
    ),
  ].find(isChatComposer);
}

function isChatComposer(element: HTMLElement): boolean {
  if (!isElementAvailable(element)) return false;
  const inputHint = compactText(
    [
      element.getAttribute("placeholder") ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("data-placeholder") ?? "",
    ].join(" "),
  );
  if (
    element.matches('input[type="search"], [role="searchbox"]') ||
    element.closest('[role="search"]') !== null ||
    /搜索|查找/.test(inputHint)
  ) {
    return false;
  }
  const chatContext = element.closest(
    '[class*="chat"], [class*="message"], [class*="conversation"], [id*="chat"], [id*="message"], [id*="conversation"]',
  );
  return chatContext !== null || /消息|沟通|发送/.test(inputHint);
}

function findSendButton(composer: HTMLElement): HTMLElement | undefined {
  const container = composer.parentElement?.closest<HTMLElement>(
    'form, [class*="chat"], [class*="message"], [class*="conversation"], [class*="dialog"], [id*="chat"], [id*="message"], [id*="conversation"]',
  );
  return container === undefined || container === null
    ? undefined
    : findExactTextAction(container, "发送");
}

function isElementAvailable(element: HTMLElement): boolean {
  if (
    ("disabled" in element &&
      Boolean((element as HTMLButtonElement).disabled)) ||
    element.getAttribute("aria-disabled") === "true"
  ) {
    return false;
  }
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true")
      return false;
    const style = compactText(
      current.getAttribute("style") ?? "",
    ).toLowerCase();
    if (/display:none|visibility:hidden/.test(style)) return false;
  }
  return true;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function outgoingMessages(document: Document): string[] {
  const elements = [
    ...document.querySelectorAll<HTMLElement>(
      '[class*="message-item"][class*="my"], [class*="message-item"][class*="self"], .item-myself',
    ),
  ];
  return elements.map(textOf).filter(Boolean);
}

function normalizeMessage(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function setComposerValue(element: HTMLElement, value: string): void {
  if ("value" in element) {
    const input = element as HTMLTextAreaElement | HTMLInputElement;
    const prototype = Object.getPrototypeOf(input) as object;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) input.value = value;
    else setter.call(input, value);
  } else {
    element.textContent = value;
  }
  const EventConstructor = element.ownerDocument.defaultView?.Event;
  if (EventConstructor !== undefined) {
    element.dispatchEvent(new EventConstructor("input", { bubbles: true }));
    element.dispatchEvent(new EventConstructor("change", { bubbles: true }));
  }
}

function composerText(element: HTMLElement): string {
  if ("value" in element) {
    return String((element as HTMLTextAreaElement | HTMLInputElement).value);
  }
  return element.textContent ?? "";
}

async function waitFor<T>(
  read: () => T | undefined | null,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = read();
    if (value !== undefined && value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error("等待页面发送结构超时");
}

async function waitForOptional<T>(
  read: () => T | undefined | null,
  timeoutMs: number,
): Promise<T | undefined> {
  try {
    return await waitFor(read, timeoutMs);
  } catch {
    return undefined;
  }
}

function readCard(
  card: HTMLElement,
  baseUrl: string,
): CandidatePosition | undefined {
  const title = optionalText(
    card.querySelector('.job-name, [class*="job-name"]'),
  );
  const company = optionalText(
    card.querySelector(
      '.company-name, .boss-name, [class*="company-name"], [class*="boss-name"]',
    ),
  );
  if (title === undefined || company === undefined) return undefined;

  const link = card.querySelector<HTMLAnchorElement>('a[href*="/job_detail/"]');
  const url = normalizeBossUrl(link?.getAttribute("href"), baseUrl);
  const id = url?.match(/\/job_detail\/([^./?]+)(?:\.html)?/)?.[1];
  const salary = parseSalary(
    optionalText(card.querySelector('.salary, [class*="salary"]')),
  );
  const area = optionalText(
    card.querySelector(
      '.job-area, .company-location, [class*="job-area"], [class*="company-location"]',
    ),
  );
  const [city, region] = area?.split(/[·・]/).map((part) => part.trim()) ?? [];
  const tags = [
    ...card.querySelectorAll<HTMLElement>(
      '.tag-list li, [class*="tag-list"] li',
    ),
  ].map(textOf);
  const companyTags = [
    ...card.querySelectorAll<HTMLElement>(
      '.company-tag-list li, [class*="company-tag"] li',
    ),
  ].map(textOf);
  const education = tags
    .map(parseEducation)
    .find((value) => value !== undefined);
  const experienceMinYears = parseExperience(tags);
  const publishedText = optionalText(
    card.querySelector(
      '.job-time, [class*="job-time"], [class*="publish-time"]',
    ),
  );

  return {
    ...(id === undefined ? {} : { id }),
    ...(url === undefined ? {} : { url }),
    title,
    company,
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...salary,
    ...(experienceMinYears === undefined ? {} : { experienceMinYears }),
    ...(education === undefined ? {} : { education }),
    ...(companyTags[0]?.trim() ? { industry: companyTags[0].trim() } : {}),
    ...(publishedText === undefined ? {} : { publishedAt: publishedText }),
    ...(title.includes("远程") || area?.includes("远程")
      ? { remote: true }
      : {}),
  };
}

function optionalText(element: Element | null): string | undefined {
  const value = element?.textContent?.trim();
  return value ? value : undefined;
}

function textOf(element: Element): string {
  return element.textContent?.trim() ?? "";
}

function normalizeBossUrl(
  value: string | null | undefined,
  baseUrl: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "zhipin.com" && !hostname.endsWith(".zhipin.com")) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function parseSalary(
  value: string | undefined,
): Pick<CandidatePosition, "salaryMinK" | "salaryMaxK"> {
  const match = value?.match(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*K/i);
  if (match?.[1] === undefined || match[2] === undefined) return {};
  return { salaryMinK: Number(match[1]), salaryMaxK: Number(match[2]) };
}

function parseExperience(tags: string[]): number | undefined {
  for (const tag of tags) {
    if (/经验不限|应届生|在校生/.test(tag)) return 0;
    const range = tag.match(/(\d+)\s*[-–—]\s*\d+\s*年/);
    if (range?.[1] !== undefined) return Number(range[1]);
    const minimum = tag.match(/(\d+)\s*年以上/);
    if (minimum?.[1] !== undefined) return Number(minimum[1]);
  }
  return undefined;
}

function parseEducation(value: string): EducationLevel | undefined {
  if (/学历不限/.test(value) || value.trim() === "不限") return "不限";
  const levels: EducationLevel[] = [
    "博士",
    "硕士",
    "本科",
    "大专",
    "中专/高中",
  ];
  return levels.find((level) => value.includes(level));
}

function safePathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}
