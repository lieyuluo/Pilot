import type { CandidatePosition } from "../core/rules.ts";
import {
  BOSS_ADAPTER_VERSION,
  EXTENSION_PROTOCOL_VERSION,
  type BoundBossPage,
  type CalibrationCommand,
  type CalibrationResult,
  type ExtensionCommand,
  type ExtensionToServerMessage,
  type InspectPositionCommand,
  type InspectPositionResult,
  type PagePreparationStatus,
  type ScanPlanCommand,
  type ScanPlanResult,
  type SendOpeningCommand,
  type SendOpeningExecutionResult,
  type ServerToExtensionMessage,
} from "./protocol.ts";
import type { BossPageInspection } from "./boss-dom.ts";

const SOCKET_URL = "ws://127.0.0.1:4317/extension";
const STORAGE_INSTANCE_ID = "jobpilotInstanceId";
const STORAGE_PAIRING_SECRET = "jobpilotPairingSecret";
const STORAGE_COMMAND_RESULTS = "jobpilotCommandResultsV2";
const STORAGE_PENDING_OPENING_TEMPLATE = "jobpilotPendingOpeningTemplateV1";
const PAGE_STRUCTURE_TIMEOUT_MS = 10_000;
const PAGE_STRUCTURE_POLL_MS = 250;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let socket: WebSocket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let connectionId: string | undefined;
let boundTabId: number | undefined;
let commandRunning = false;
let handshakeReady = false;
let lastError: string | undefined;
let completedTemplateCommandId: string | undefined;
let activeTemplateCommandId: string | undefined;
let preparation: PagePreparationStatus = {
  state: "idle",
  stage: "connecting",
  message: "等待连接当前页面",
};
const commandResults = new Map<
  string,
  Extract<ExtensionToServerMessage, { type: "command_result" }>
>();
const pendingTemplateWaiters = new Map<string, () => void>();
const resumingTemplateCommands = new Set<string>();

void connect();
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!isRuntimeMessage(message)) return false;
  const senderTabId = sender.tab?.id;
  if (message.type === "get_extension_state") {
    void extensionState().then(respond);
    return true;
  }
  if (message.type === "prepare_current_page") {
    void prepareCurrentPage()
      .then(respond)
      .catch((error: unknown) => {
        const message = messageOf(error);
        preparation = {
          state: "error",
          stage: preparation.stage,
          message: "页面尚未就绪",
          error: message,
        };
        lastError = message;
        respond({ ok: false, error: message });
      });
    return true;
  }
  if (message.type === "emergency_stop") {
    emergencyStop();
    respond({ ok: true });
    return false;
  }
  if (
    message.type === "opening_template_continuation_complete" &&
    senderTabId === boundTabId &&
    activeTemplateCommandId !== undefined
  ) {
    const commandId = runtimeMessageCommandId(message);
    if (commandId === activeTemplateCommandId) {
      completedTemplateCommandId = commandId;
      void settlePendingOpeningTemplate(commandId);
    }
    return false;
  }
  if (
    (message.type === "page_loaded" || message.type === "page_visibility") &&
    senderTabId === boundTabId
  ) {
    if (senderTabId !== undefined) {
      const visibility = (message as { visible?: unknown }).visible;
      const loadedUrl = runtimeMessageUrl(message);
      void handlePageSignal(
        senderTabId,
        typeof visibility === "boolean" ? visibility : undefined,
        message.type === "page_loaded" ? loadedUrl : undefined,
      );
    }
  }
  return false;
});

async function connect(): Promise<void> {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  try {
    const next = new WebSocket(SOCKET_URL);
    socket = next;
    next.addEventListener("open", () => {
      lastError = undefined;
      heartbeatTimer = setInterval(() => send({ type: "heartbeat" }), 5_000);
    });
    next.addEventListener("message", (event) => {
      try {
        void receiveServerMessage(parseServerMessage(String(event.data)));
      } catch (error) {
        lastError = messageOf(error);
        next.close(4400, "本机服务消息无效");
      }
    });
    next.addEventListener("close", () => {
      if (socket === next) socket = undefined;
      connectionId = undefined;
      boundTabId = undefined;
      handshakeReady = false;
      completedTemplateCommandId = undefined;
      activeTemplateCommandId = undefined;
      void settlePendingOpeningTemplate();
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      scheduleReconnect();
    });
    next.addEventListener("error", () => {
      lastError = "无法连接本机 JobPilot";
    });
  } catch (error) {
    lastError = messageOf(error);
    scheduleReconnect();
  }
}

async function receiveServerMessage(
  message: ServerToExtensionMessage,
): Promise<void> {
  if (message.type === "challenge") {
    const instanceId = await getOrCreateInstanceId();
    const stored = await chrome.storage.local.get(STORAGE_PAIRING_SECRET);
    const secret = stored[STORAGE_PAIRING_SECRET];
    send({
      type: "hello",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: EXTENSION_VERSION,
      adapterVersion: BOSS_ADAPTER_VERSION,
      instanceId,
      capabilities: ["read", "batch-send"],
      ...(typeof secret === "string"
        ? {
            challengeProof: await challengeProof(
              secret,
              message.nonce,
              instanceId,
            ),
          }
        : {}),
    });
    return;
  }
  if (message.type === "authorization_required") {
    await chrome.storage.local.remove(STORAGE_PAIRING_SECRET);
    connectionId = undefined;
    boundTabId = undefined;
    completedTemplateCommandId = undefined;
    activeTemplateCommandId = undefined;
    await clearPendingOpeningTemplate();
    handshakeReady = true;
    return;
  }
  if (message.type === "pairing_accepted") {
    await chrome.storage.local.set({
      [STORAGE_PAIRING_SECRET]: message.pairingSecret,
    });
    connectionId = message.connectionId;
    handshakeReady = true;
    lastError = undefined;
    return;
  }
  if (message.type === "ready") {
    connectionId = message.connectionId;
    handshakeReady = true;
    lastError = undefined;
    return;
  }
  if (message.type === "page_bound") {
    boundTabId = message.tabId;
    lastError = undefined;
    const pending = await getPendingOpeningTemplate();
    if (
      pending !== undefined &&
      (pending.tabId !== message.tabId ||
        pending.connectionId !== message.connectionId)
    ) {
      await clearPendingOpeningTemplate();
    }
    return;
  }
  if (message.type === "preparation_state") {
    preparation = { ...message.status };
    lastError = message.status.error;
    return;
  }
  if (message.type === "disarm") {
    boundTabId = undefined;
    completedTemplateCommandId = undefined;
    activeTemplateCommandId = undefined;
    await clearPendingOpeningTemplate();
    lastError = message.reason;
    return;
  }
  if (message.type === "error") {
    lastError = message.message;
    if (preparation.state === "running") {
      preparation = {
        state: "error",
        stage: preparation.stage,
        message: "页面尚未就绪",
        error: message.message,
      };
    }
    return;
  }
  await executeCommand(message.command);
}

async function executeCommand(command: ExtensionCommand): Promise<void> {
  commandRunning = true;
  try {
    if (
      connectionId !== command.connectionId ||
      boundTabId !== command.expectedTabId
    ) {
      throw new Error("页面命令不属于当前页面连接");
    }
    await clearReplacedPendingOpeningTemplate(command.commandId);
    if (
      completedTemplateCommandId !== undefined &&
      completedTemplateCommandId !== command.commandId
    ) {
      completedTemplateCommandId = undefined;
    }
    const cached =
      commandResults.get(command.commandId) ??
      (await getPersistedCommandResult(command.commandId));
    if (cached !== undefined) {
      let replayResult = cached;
      const pending = await getPendingOpeningTemplate();
      if (pending?.commandId === command.commandId) {
        if (!isPendingOpeningTemplateBoundToCommand(pending, command)) {
          await clearPendingOpeningTemplate(command.commandId);
          send(cached);
          return;
        }
        const continuation = waitForPendingOpeningTemplate(
          command.commandId,
          pending.deadline,
        );
        const tab = await chrome.tabs.get(pending.tabId).catch(() => undefined);
        if (tab?.url !== undefined && tab.url !== pending.sourceUrl) {
          void attemptPendingOpeningTemplateResume(pending.tabId, tab.url);
        }
        await continuation;
        replayResult = await refreshCommandResultCurrentUrl(
          cached,
          pending.tabId,
        );
        if (replayResult !== cached) {
          await cacheCommandResult(replayResult);
        }
      }
      send(replayResult);
      return;
    }
    if (new Date(command.deadline).getTime() <= Date.now()) {
      throw new Error("页面命令已经过期");
    }
    const current = await chrome.tabs.get(boundTabId);
    if (current.url !== command.expectedUrl) {
      throw new Error("当前页面已经变化，请重新连接标签页");
    }
    let result: unknown;
    if (command.type === "calibrate") {
      result = await calibrate(command, boundTabId);
    } else if (command.type === "scan-plan") {
      result = await scanPlan(command, boundTabId);
    } else if (command.type === "inspect-position") {
      result = await inspectPosition(command, boundTabId);
    } else {
      const tab = await chrome.tabs.get(boundTabId);
      if (!tab.active) {
        result = sendResult("明确未开始", false, tab.url, "批次页面当前不可见");
      } else {
        const placeholder: Extract<
          ExtensionToServerMessage,
          { type: "command_result" }
        > = {
          type: "command_result",
          commandId: command.commandId,
          outcome: "ok",
          data: sendResult("结果未知", true, tab.url, "扩展在沟通操作期间中断"),
        };
        await persistCommandResult(placeholder);
        activeTemplateCommandId = command.commandId;
        try {
          result = await sendOpening(command, boundTabId);
        } finally {
          if (activeTemplateCommandId === command.commandId) {
            activeTemplateCommandId = undefined;
          }
        }
      }
    }
    await completeCommand({
      type: "command_result",
      commandId: command.commandId,
      outcome: "ok",
      data: result,
    });
  } catch (error) {
    const message = messageOf(error);
    const currentTab =
      boundTabId === undefined
        ? undefined
        : await chrome.tabs.get(boundTabId).catch(() => undefined);
    await completeCommand({
      type: "command_result",
      commandId: command.commandId,
      outcome: /登录|验证|风控|访问异常/.test(message) ? "takeover" : "error",
      error: message,
      ...(currentTab?.url === undefined
        ? {}
        : { data: { currentUrl: currentTab.url } }),
    });
  } finally {
    commandRunning = false;
  }
}

async function completeCommand(
  result: Extract<ExtensionToServerMessage, { type: "command_result" }>,
): Promise<void> {
  await cacheCommandResult(result);
  send(result);
}

async function cacheCommandResult(
  result: Extract<ExtensionToServerMessage, { type: "command_result" }>,
): Promise<void> {
  commandResults.set(result.commandId, result);
  if (commandResults.size > 100) {
    const oldest = commandResults.keys().next().value;
    if (oldest !== undefined) commandResults.delete(oldest);
  }
  await persistCommandResult(result);
}

async function calibrate(
  command: CalibrationCommand,
  tabId: number,
): Promise<CalibrationResult> {
  const commandDeadline = new Date(command.deadline).getTime();
  await navigate(tabId, command.searchUrl);
  const list = await readTabWhenReady<{
    inspection: BossPageInspection;
    candidates: CandidatePosition[];
  }>(
    tabId,
    { type: "read_candidates" },
    "list",
    commandDeadline,
    (result) => result.candidates.length > 0,
  );
  if (list.candidates.length === 0) {
    throw new Error("未识别到受支持的职位列表结构");
  }
  const first = list.candidates.find(
    (candidate) => candidate.url !== undefined,
  );
  if (first?.url === undefined) {
    throw new Error("职位列表没有可读取的详情链接");
  }
  await navigate(tabId, first.url);
  const detail = await readTabWhenReady<{
    inspection: BossPageInspection;
    contactState: CalibrationResult["contactState"];
  }>(tabId, { type: "read_contact_state" }, "detail", commandDeadline);
  send({ type: "preparation_progress", stage: "returning" });
  let returnWarning: string | undefined;
  try {
    await navigate(tabId, command.searchUrl);
  } catch (error) {
    returnWarning = `页面检查已通过，但返回搜索列表失败：${messageOf(error)}`;
  }
  const tab = await chrome.tabs.get(tabId);
  return {
    candidatesRecognized: list.candidates.length,
    currentUrl: tab.url ?? detail.inspection.url,
    contactState: detail.contactState,
    ...(returnWarning === undefined ? {} : { returnWarning }),
  };
}

async function scanPlan(
  command: ScanPlanCommand,
  tabId: number,
): Promise<ScanPlanResult> {
  const deadline = new Date(command.deadline).getTime();
  await navigate(tabId, command.searchUrl);
  const list = await readTabWhenReady<{
    inspection: BossPageInspection;
    candidates: CandidatePosition[];
  }>(
    tabId,
    { type: "read_candidates" },
    "list",
    deadline,
    (result) => result.candidates.length > 0,
  );
  const tab = await chrome.tabs.get(tabId);
  return {
    candidates: list.candidates,
    currentUrl: tab.url ?? command.searchUrl,
  };
}

async function inspectPosition(
  command: InspectPositionCommand,
  tabId: number,
): Promise<InspectPositionResult> {
  if (command.candidate.url === undefined) {
    throw new Error("真实发送要求职位详情 URL");
  }
  const deadline = new Date(command.deadline).getTime();
  await navigate(tabId, command.candidate.url);
  const detail = await readTabWhenReady<{
    inspection: BossPageInspection;
    candidate?: CandidatePosition;
    contactState: InspectPositionResult["contactState"];
  }>(
    tabId,
    { type: "inspect_position", candidate: command.candidate },
    "detail",
    deadline,
    (result) => result.candidate !== undefined,
  );
  if (detail.candidate === undefined) {
    throw new Error("无法在职位详情页重新读取职位身份");
  }
  const tab = await chrome.tabs.get(tabId);
  return {
    candidate: detail.candidate,
    contactState: detail.contactState,
    currentUrl: tab.url ?? detail.inspection.url,
  };
}

async function sendOpening(
  command: SendOpeningCommand,
  tabId: number,
): Promise<SendOpeningExecutionResult> {
  const response = await sendTabMessage<{
    inspection: BossPageInspection;
    result: SendOpeningExecutionResult["result"];
    irreversibleStarted: boolean;
    baselineOutgoingCount: number;
    finalOutgoingCount: number;
    confirmation?: "matched-message" | "boss-success-dialog";
    error?: string;
  }>(tabId, {
    type: "send_opening",
    commandId: command.commandId,
    message: command.message,
  });
  const takeover = takeoverFromInspection(response.inspection);
  if (takeover !== undefined && response.result !== "沟通成功") {
    assertNoTakeover(response.inspection);
  }
  const tab = await chrome.tabs.get(tabId);
  const executionResult: SendOpeningExecutionResult = {
    result: response.result,
    irreversibleStarted: response.irreversibleStarted,
    currentUrl: tab.url ?? response.inspection.url,
    evidence: {
      baselineOutgoingCount: response.baselineOutgoingCount,
      finalOutgoingCount: response.finalOutgoingCount,
      ...(response.confirmation === undefined
        ? {}
        : { confirmation: response.confirmation }),
      ...(response.confirmation === "matched-message"
        ? { matchedMessageHash: command.messageHash }
        : {}),
    },
    ...(takeover === undefined ? {} : { takeover }),
    ...(response.error === undefined ? {} : { error: response.error }),
  };
  if (
    response.result === "沟通成功" &&
    response.confirmation === "boss-success-dialog"
  ) {
    const confirmedCommandResult: Extract<
      ExtensionToServerMessage,
      { type: "command_result" }
    > = {
      type: "command_result",
      commandId: command.commandId,
      outcome: "ok",
      data: executionResult,
    };
    try {
      await cacheCommandResult(confirmedCommandResult);
      if (completedTemplateCommandId === command.commandId) {
        completedTemplateCommandId = undefined;
        return executionResult;
      }
      const continuation = waitForPendingOpeningTemplate(
        command.commandId,
        command.deadline,
      );
      await persistPendingOpeningTemplate({
        state: "pending",
        commandId: command.commandId,
        connectionId: command.connectionId,
        tabId,
        sourceUrl: command.expectedUrl,
        deadline: command.deadline,
        message: command.message,
      });
      if (completedTemplateCommandId === command.commandId) {
        completedTemplateCommandId = undefined;
        await clearPendingOpeningTemplate(command.commandId);
      }
      const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (
        currentTab?.url !== undefined &&
        currentTab.url !== command.expectedUrl
      ) {
        void attemptPendingOpeningTemplateResume(tabId, currentTab.url);
      }
      await continuation;
    } catch (error) {
      lastError = `保存或等待开场模板续作失败：${messageOf(error)}`;
      await settlePendingOpeningTemplate(command.commandId);
    }
  } else {
    await clearPendingOpeningTemplate(command.commandId);
  }
  const currentUrl = await currentTabUrl(tabId, executionResult.currentUrl);
  return currentUrl === executionResult.currentUrl
    ? executionResult
    : { ...executionResult, currentUrl };
}

async function refreshCommandResultCurrentUrl(
  result: Extract<ExtensionToServerMessage, { type: "command_result" }>,
  tabId: number,
): Promise<Extract<ExtensionToServerMessage, { type: "command_result" }>> {
  if (!isRecord(result.data) || typeof result.data.currentUrl !== "string") {
    return result;
  }
  const currentUrl = await currentTabUrl(tabId, result.data.currentUrl);
  return currentUrl === result.data.currentUrl
    ? result
    : { ...result, data: { ...result.data, currentUrl } };
}

async function currentTabUrl(tabId: number, fallback: string): Promise<string> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  return tab?.url ?? fallback;
}

function sendResult(
  result: SendOpeningExecutionResult["result"],
  irreversibleStarted: boolean,
  currentUrl: string | undefined,
  error: string,
): SendOpeningExecutionResult {
  return {
    result,
    irreversibleStarted,
    currentUrl: currentUrl ?? "https://www.zhipin.com/",
    error,
  };
}

async function sendTabMessage<T>(
  tabId: number,
  message: { type: string; [key: string]: unknown },
): Promise<T> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as T;
    } catch (error) {
      lastFailure = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(
    `页面读取脚本尚未就绪：${messageOf(lastFailure)}。请刷新 BOSS 页面后重试。`,
  );
}

async function readTabWhenReady<T extends { inspection: BossPageInspection }>(
  tabId: number,
  message: { type: string; [key: string]: unknown },
  expectedKind: "list" | "detail",
  commandDeadline: number,
  isComplete: (result: T) => boolean = () => true,
): Promise<T> {
  const readinessDeadline = Math.min(
    commandDeadline,
    Date.now() + PAGE_STRUCTURE_TIMEOUT_MS,
  );
  let lastInspection: BossPageInspection | undefined;
  let lastExpectedResult: T | undefined;
  do {
    const result = await sendTabMessage<T>(tabId, message);
    lastInspection = result.inspection;
    assertNoTakeover(lastInspection);
    if (lastInspection.kind === expectedKind) {
      lastExpectedResult = result;
      if (isComplete(result)) return result;
    }
    const remaining = readinessDeadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(PAGE_STRUCTURE_POLL_MS, remaining)),
    );
  } while (Date.now() < readinessDeadline);

  if (lastInspection !== undefined) assertNoTakeover(lastInspection);
  if (lastExpectedResult !== undefined) return lastExpectedResult;
  throw new Error("当前 Boss 页面结构不受支持");
}

async function prepareCurrentPage(): Promise<{
  ok: true;
  page: BoundBossPage;
}> {
  if (preparation.state === "running") {
    return { ok: true, page: await activeBossPage() };
  }
  preparation = {
    state: "running",
    stage: "connecting",
    message: "正在连接本机…",
  };
  await connect();
  await waitForHandshake();
  const page = await activeBossPageWithRetry();
  preparation = {
    state: "running",
    stage: connectionId === undefined ? "authorizing" : "binding",
    message: connectionId === undefined ? "正在授权扩展…" : "正在连接当前页面…",
  };
  send({ type: "prepare_page", tab: page });
  return { ok: true, page };
}

async function activeBossPage(): Promise<BoundBossPage> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.url === undefined || !isBossUrl(tab.url)) {
    throw new Error("请先打开并登录 Boss 官方页面");
  }
  const inspection = await sendTabMessage<BossPageInspection>(tab.id, {
    type: "inspect_page",
  });
  assertReadable(inspection, true);
  const page: BoundBossPage = {
    tabId: tab.id,
    url: tab.url,
    active: tab.active,
    visible: true,
    ...(inspection.accountDisplayName === undefined
      ? {}
      : { accountDisplayName: inspection.accountDisplayName }),
  };
  return page;
}

async function activeBossPageWithRetry(): Promise<BoundBossPage> {
  try {
    return await activeBossPage();
  } catch (error) {
    if (/登录|验证|风控|官方页面|结构不受支持/.test(messageOf(error)))
      throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return activeBossPage();
  }
}

async function waitForHandshake(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (socket?.readyState === WebSocket.OPEN && handshakeReady) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("连接本机 JobPilot 超时");
}

async function reportPageState(tabId: number, visible = true): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url === undefined) return;
    const inspection = (await chrome.tabs.sendMessage(tabId, {
      type: "inspect_page",
    })) as BossPageInspection;
    send({
      type: "page_state",
      tab: {
        tabId,
        url: tab.url,
        active: tab.active,
        visible,
        ...(inspection.accountDisplayName === undefined
          ? {}
          : { accountDisplayName: inspection.accountDisplayName }),
      },
    });
  } catch (error) {
    if (commandRunning) return;
    lastError = `已连接页面无法读取：${messageOf(error)}`;
    send({ type: "emergency_stop", reason: lastError });
    boundTabId = undefined;
  }
}

async function handlePageSignal(
  tabId: number,
  visible: boolean | undefined,
  loadedUrl: string | undefined,
): Promise<void> {
  if (loadedUrl !== undefined) {
    await attemptPendingOpeningTemplateResume(tabId, loadedUrl);
  }
  await reportPageState(tabId, visible);
}

async function navigate(tabId: number, url: string): Promise<void> {
  if (!isBossUrl(url)) throw new Error("拒绝导航到非 Boss 域名");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timeout = setTimeout(() => {
      finish(new Error("Boss 页面加载超时"));
    }, 30_000);
    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
    ) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs
      .update(tabId, { url })
      .then((tab) => {
        if (tab?.status === "complete") finish();
      })
      .catch((error: unknown) => finish(new Error(messageOf(error))));
  });
}

function assertReadable(
  inspection: BossPageInspection,
  allowDetail = false,
): void {
  assertNoTakeover(inspection);
  if (
    inspection.kind === "unsupported" ||
    (!allowDetail && !["list", "detail"].includes(inspection.kind))
  ) {
    throw new Error("当前 Boss 页面结构不受支持");
  }
}

function assertNoTakeover(inspection: BossPageInspection): void {
  if (inspection.kind === "login") throw new Error("Boss 登录状态已失效");
  if (inspection.kind === "verification") {
    throw new Error("Boss 页面出现验证或风控提示");
  }
}

function takeoverFromInspection(
  inspection: BossPageInspection,
): SendOpeningExecutionResult["takeover"] | undefined {
  if (inspection.kind === "login") {
    return { kind: "login", reason: "Boss 登录状态已失效" };
  }
  if (inspection.kind === "verification") {
    return { kind: "verification", reason: "Boss 页面出现验证或风控提示" };
  }
  return undefined;
}

async function extensionState() {
  return {
    serverConnected: socket?.readyState === WebSocket.OPEN,
    authorized: connectionId !== undefined,
    pageConnected: boundTabId !== undefined,
    boundTabId,
    lastError,
    preparation: { ...preparation },
  };
}

function emergencyStop(): void {
  send({ type: "emergency_stop", reason: "求职者通过扩展紧急停止" });
  boundTabId = undefined;
  completedTemplateCommandId = undefined;
  activeTemplateCommandId = undefined;
  void settlePendingOpeningTemplate();
  preparation = {
    state: "idle",
    stage: "connecting",
    message: "页面连接已解除",
  };
}

function send(message: ExtensionToServerMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

interface PersistedCommandResult {
  at: string;
  result: Extract<ExtensionToServerMessage, { type: "command_result" }>;
}

interface PendingOpeningTemplate {
  state: "pending" | "dispatching";
  commandId: string;
  connectionId: string;
  tabId: number;
  sourceUrl: string;
  deadline: string;
  message: string;
}

async function persistPendingOpeningTemplate(
  pending: PendingOpeningTemplate,
): Promise<void> {
  await chrome.storage.session.set({
    [STORAGE_PENDING_OPENING_TEMPLATE]: pending,
  });
}

async function getPendingOpeningTemplate(): Promise<
  PendingOpeningTemplate | undefined
> {
  const stored = await chrome.storage.session.get(
    STORAGE_PENDING_OPENING_TEMPLATE,
  );
  const value = stored[STORAGE_PENDING_OPENING_TEMPLATE];
  if (value === undefined) return undefined;
  if (isPendingOpeningTemplate(value)) return value;
  await chrome.storage.session.remove(STORAGE_PENDING_OPENING_TEMPLATE);
  return undefined;
}

async function clearPendingOpeningTemplate(commandId?: string): Promise<void> {
  const pending = await getPendingOpeningTemplate();
  if (commandId !== undefined) {
    if (pending?.commandId !== commandId) {
      if (pending === undefined) pendingTemplateWaiters.get(commandId)?.();
      return;
    }
  }
  await chrome.storage.session.remove(STORAGE_PENDING_OPENING_TEMPLATE);
  if (commandId === undefined) {
    for (const finish of [...pendingTemplateWaiters.values()]) finish();
    return;
  }
  pendingTemplateWaiters.get(commandId)?.();
}

function waitForPendingOpeningTemplate(
  commandId: string,
  deadline: string,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingTemplateWaiters.delete(commandId);
      resolve();
    };
    const timeout = setTimeout(
      () => {
        void clearPendingOpeningTemplate(commandId)
          .catch((error: unknown) => {
            lastError = `清理过期开场模板续作失败：${messageOf(error)}`;
          })
          .finally(finish);
      },
      Math.max(1, Date.parse(deadline) - Date.now()),
    );
    pendingTemplateWaiters.set(commandId, finish);
  });
}

async function clearReplacedPendingOpeningTemplate(
  commandId: string,
): Promise<void> {
  const pending = await getPendingOpeningTemplate();
  if (pending !== undefined && pending.commandId !== commandId) {
    await clearPendingOpeningTemplate();
  }
}

async function resumePendingOpeningTemplate(
  tabId: number,
  loadedUrl: string,
): Promise<void> {
  const pending = await getPendingOpeningTemplate();
  if (pending === undefined) return;
  if (resumingTemplateCommands.has(pending.commandId)) return;
  if (pending.state === "dispatching") {
    await clearPendingOpeningTemplate(pending.commandId);
    return;
  }
  if (Date.parse(pending.deadline) <= Date.now()) {
    await clearPendingOpeningTemplate(pending.commandId);
    return;
  }
  if (
    pending.connectionId !== connectionId ||
    pending.tabId !== tabId ||
    boundTabId !== tabId
  ) {
    await clearPendingOpeningTemplate(pending.commandId);
    return;
  }
  if (loadedUrl === pending.sourceUrl) return;
  if (!isBossChatUrl(loadedUrl)) {
    await clearPendingOpeningTemplate(pending.commandId);
    return;
  }

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.url !== loadedUrl) return;
  const current = await getPendingOpeningTemplate();
  if (
    current?.commandId !== pending.commandId ||
    resumingTemplateCommands.has(pending.commandId)
  ) {
    return;
  }
  resumingTemplateCommands.add(pending.commandId);
  try {
    await persistPendingOpeningTemplate({ ...pending, state: "dispatching" });
    await sendTabMessage<{
      completed: boolean;
      error?: string;
    }>(tabId, {
      type: "resume_opening_template",
      commandId: pending.commandId,
      message: pending.message,
      deadline: pending.deadline,
    });
  } finally {
    try {
      await clearPendingOpeningTemplate(pending.commandId);
    } finally {
      resumingTemplateCommands.delete(pending.commandId);
    }
  }
}

async function attemptPendingOpeningTemplateResume(
  tabId: number,
  loadedUrl: string,
): Promise<void> {
  try {
    await resumePendingOpeningTemplate(tabId, loadedUrl);
  } catch (error) {
    lastError = `开场模板续作失败：${messageOf(error)}`;
    try {
      await clearPendingOpeningTemplate();
    } catch (clearError) {
      lastError = `清理开场模板续作失败：${messageOf(clearError)}`;
    }
  }
}

async function settlePendingOpeningTemplate(commandId?: string): Promise<void> {
  try {
    await clearPendingOpeningTemplate(commandId);
  } catch (error) {
    lastError = `清理开场模板续作失败：${messageOf(error)}`;
  }
}

function isPendingOpeningTemplate(
  value: unknown,
): value is PendingOpeningTemplate {
  return (
    isRecord(value) &&
    (value.state === "pending" || value.state === "dispatching") &&
    isShortString(value.commandId, 100) &&
    isShortString(value.connectionId, 100) &&
    Number.isSafeInteger(value.tabId) &&
    isShortString(value.sourceUrl, 4_096) &&
    isBossUrl(value.sourceUrl) &&
    isShortString(value.deadline, 100) &&
    Number.isFinite(Date.parse(value.deadline)) &&
    isShortString(value.message, 4_000)
  );
}

function isPendingOpeningTemplateBoundToCommand(
  pending: PendingOpeningTemplate,
  command: ExtensionCommand,
): boolean {
  return (
    command.type === "send-opening" &&
    pending.commandId === command.commandId &&
    pending.connectionId === command.connectionId &&
    pending.tabId === command.expectedTabId &&
    pending.sourceUrl === command.expectedUrl &&
    pending.deadline === command.deadline &&
    pending.message === command.message
  );
}

async function getPersistedCommandResult(
  commandId: string,
): Promise<
  Extract<ExtensionToServerMessage, { type: "command_result" }> | undefined
> {
  const stored = await chrome.storage.local.get(STORAGE_COMMAND_RESULTS);
  const values = stored[STORAGE_COMMAND_RESULTS] as
    Record<string, PersistedCommandResult> | undefined;
  const result = values?.[commandId]?.result;
  if (result !== undefined) commandResults.set(commandId, result);
  return result;
}

async function persistCommandResult(
  result: Extract<ExtensionToServerMessage, { type: "command_result" }>,
): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_COMMAND_RESULTS);
  const values =
    (stored[STORAGE_COMMAND_RESULTS] as
      Record<string, PersistedCommandResult> | undefined) ?? {};
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1_000;
  for (const [commandId, entry] of Object.entries(values)) {
    if (new Date(entry.at).getTime() < cutoff) delete values[commandId];
  }
  values[result.commandId] = { at: new Date().toISOString(), result };
  await chrome.storage.local.set({ [STORAGE_COMMAND_RESULTS]: values });
}

async function getOrCreateInstanceId(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_INSTANCE_ID);
  if (typeof stored[STORAGE_INSTANCE_ID] === "string") {
    return stored[STORAGE_INSTANCE_ID] as string;
  }
  const instanceId = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_INSTANCE_ID]: instanceId });
  return instanceId;
}

async function challengeProof(
  secret: string,
  nonce: string,
  instanceId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${nonce}:${instanceId}`),
  );
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function isBossUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "zhipin.com" || hostname.endsWith(".zhipin.com");
  } catch {
    return false;
  }
}

function isBossChatUrl(value: string): boolean {
  if (!isBossUrl(value)) return false;
  try {
    return /(?:^|\/)chat(?:\/|$)/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function runtimeMessageUrl(message: { type: string }): string | undefined {
  if (!("inspection" in message)) return undefined;
  const inspection = message.inspection;
  if (!isRecord(inspection) || typeof inspection.url !== "string") {
    return undefined;
  }
  return inspection.url;
}

function runtimeMessageCommandId(message: {
  type: string;
}): string | undefined {
  if (!("commandId" in message)) return undefined;
  return isShortString(message.commandId, 100) ? message.commandId : undefined;
}

function isRuntimeMessage(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && "type" in value;
}

function parseServerMessage(raw: string): ServerToExtensionMessage {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("本机服务消息缺少类型");
  }
  if (value.type === "challenge") {
    if (
      Number(value.protocolVersion) !== EXTENSION_PROTOCOL_VERSION ||
      !isShortString(value.nonce, 200)
    ) {
      throw new Error("本机挑战消息格式无效");
    }
  } else if (value.type === "authorization_required") {
    // The explicit click in the extension is the authorization gesture.
  } else if (value.type === "pairing_accepted") {
    if (
      !isShortString(value.pairingSecret, 200) ||
      !isShortString(value.connectionId, 100)
    ) {
      throw new Error("本机配对确认格式无效");
    }
  } else if (value.type === "ready") {
    if (!isShortString(value.connectionId, 100)) {
      throw new Error("本机连接确认格式无效");
    }
  } else if (value.type === "page_bound") {
    if (
      !isShortString(value.connectionId, 100) ||
      !Number.isSafeInteger(value.tabId)
    ) {
      throw new Error("本机页面连接确认格式无效");
    }
  } else if (value.type === "preparation_state") {
    if (!isPagePreparationStatus(value.status)) {
      throw new Error("本机页面准备状态格式无效");
    }
  } else if (value.type === "disarm") {
    if (!isShortString(value.reason, 500)) {
      throw new Error("本机停止消息格式无效");
    }
  } else if (value.type === "error") {
    if (
      !isShortString(value.code, 100) ||
      !isShortString(value.message, 1_000)
    ) {
      throw new Error("本机错误消息格式无效");
    }
  } else if (value.type !== "command") {
    throw new Error("本机服务消息类型无效");
  }
  if (value.type === "command") {
    const command = (value as { command?: Partial<ExtensionCommand> }).command;
    if (
      command === undefined ||
      !["calibrate", "scan-plan", "inspect-position", "send-opening"].includes(
        String(command.type),
      ) ||
      typeof command.commandId !== "string" ||
      typeof command.connectionId !== "string" ||
      !Number.isSafeInteger(command.expectedTabId) ||
      typeof command.expectedUrl !== "string" ||
      typeof command.deadline !== "string"
    ) {
      throw new Error("本机页面命令格式无效");
    }
    if (
      (command.type === "calibrate" || command.type === "scan-plan") &&
      typeof command.searchUrl !== "string"
    ) {
      throw new Error("本机导航命令格式无效");
    }
    if (
      (command.type === "inspect-position" ||
        command.type === "send-opening") &&
      !isCandidate(command.candidate)
    ) {
      throw new Error("本机职位命令格式无效");
    }
    if (
      command.type === "send-opening" &&
      (!isShortString(command.operationId, 100) ||
        !isShortString(command.message, 4_000) ||
        !/^[a-f0-9]{64}$/.test(String(command.messageHash)))
    ) {
      throw new Error("本机发送命令格式无效");
    }
  }
  return value as ServerToExtensionMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPagePreparationStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    ["idle", "running", "ready", "error"].includes(String(value.state)) &&
    [
      "connecting",
      "authorizing",
      "binding",
      "calibrating",
      "returning",
      "ready",
    ].includes(String(value.stage)) &&
    isShortString(value.message, 500) &&
    (value.error === undefined || isShortString(value.error, 1_000)) &&
    (value.warning === undefined || isShortString(value.warning, 1_000))
  );
}

function isShortString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isCandidate(value: unknown): value is CandidatePosition {
  return (
    isRecord(value) &&
    isShortString(value.title, 500) &&
    isShortString(value.company, 500) &&
    (value.id === undefined || isShortString(value.id, 500)) &&
    (value.url === undefined || isShortString(value.url, 4_096))
  );
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, 3_000);
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : "扩展发生未知错误";
}
