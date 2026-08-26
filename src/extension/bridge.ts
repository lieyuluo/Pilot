import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { SearchPlan } from "../core/config.ts";
import type { CandidatePosition } from "../core/rules.ts";
import type { SendOpeningRequest } from "../core/batch-runner.ts";
import {
  BOSS_ADAPTER_VERSION,
  EXTENSION_MESSAGE_LIMIT_BYTES,
  EXTENSION_PROTOCOL_VERSION,
  type BoundBossPage,
  type CalibrationResult,
  type ExtensionCapability,
  type ExtensionCommand,
  type ExtensionStatus,
  type ExtensionToServerMessage,
  type InspectPositionResult,
  type PagePreparationStatus,
  type ScanPlanResult,
  type SendOpeningExecutionResult,
  type ServerToExtensionMessage,
} from "./protocol.ts";

const SERVER_CAPABILITIES = ["read", "batch-send"] as const;

const PAIRING_SETTING_KEY = "extensionPairing";

interface ExtensionPairingRecord {
  instanceId: string;
  pairingSecret: string;
  approvedAt: string;
}

interface SettingsPort {
  getSetting<T>(key: string, fallback: T): T;
  setSetting<T>(key: string, value: T): void;
}

export interface BridgeSocket {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  on(
    event: "message" | "close",
    listener: ((message: unknown) => Promise<void> | void) | (() => void),
  ): this;
}

export interface ExtensionBridge {
  attach(socket: BridgeSocket): void;
  getStatus(): ExtensionStatus;
  setPreparationHandler?(handler: () => Promise<SearchPlan>): void;
  resetPairing(): void;
  calibrate(plan: SearchPlan): Promise<CalibrationResult>;
  scan(plan: SearchPlan): Promise<ScanPlanResult>;
  inspect(candidate: CandidatePosition): Promise<InspectPositionResult>;
  sendOpening(request: SendOpeningRequest): Promise<SendOpeningExecutionResult>;
  waitUntilPageReady(onWaiting: () => void): Promise<void>;
  emergencyStop(reason?: string): void;
  close(): void;
}

interface ExtensionBridgeOptions {
  settings: SettingsPort;
  commandTimeoutMs?: number;
  now?: () => Date;
}

interface ActiveConnection {
  socket: BridgeSocket;
  nonce: string;
  lastSeenAt: number;
  authenticated: boolean;
  instanceId?: string;
  extensionVersion?: string;
  adapterVersion?: number;
  capabilities: ExtensionCapability[];
  connectionId?: string;
  page?: BoundBossPage;
  readOnlyCalibrated: boolean;
}

interface PendingAuthorization {
  instanceId: string;
}

interface PendingCommand {
  kind: ExtensionCommand["type"];
  timeout: ReturnType<typeof setTimeout>;
  connectionId: string;
  tabId: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export function createExtensionBridge(
  options: ExtensionBridgeOptions,
): ExtensionBridge {
  const now = options.now ?? (() => new Date());
  const commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
  let active: ActiveConnection | undefined;
  let pendingAuthorization: PendingAuthorization | undefined;
  let preparationHandler: (() => Promise<SearchPlan>) | undefined;
  let preparationPromise: Promise<void> | undefined;
  let preparationTabId: number | undefined;
  let preparation: PagePreparationStatus = {
    state: "idle",
    stage: "connecting",
    message: "等待从目标 BOSS 页面发起连接",
  };
  const pendingCommands = new Map<string, PendingCommand>();
  const heartbeatSweep = setInterval(() => {
    if (active !== undefined && Date.now() - active.lastSeenAt > 15_000) {
      active.socket.close(4408, "扩展心跳超时");
      disconnectActive("扩展连接已断开：心跳超时");
    }
  }, 5_000);
  heartbeatSweep.unref?.();

  return {
    attach(socket) {
      if (active !== undefined) {
        socket.close(4409, "已有扩展连接");
        return;
      }
      active = {
        socket,
        nonce: randomBytes(32).toString("base64url"),
        lastSeenAt: Date.now(),
        authenticated: false,
        capabilities: [],
        readOnlyCalibrated: false,
      };
      send(socket, {
        type: "challenge",
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        nonce: active.nonce,
      });
      socket.on("message", async (raw) => {
        await receive(raw);
      });
      socket.on("close", () => {
        if (active?.socket === socket) {
          disconnectActive("扩展连接已断开");
        }
      });
    },
    getStatus() {
      const pairing = pairingRecord();
      return {
        pairingState:
          pairing !== undefined
            ? "已授权"
            : pendingAuthorization === undefined
              ? "未授权"
              : "等待授权",
        connectionState:
          active?.authenticated !== true
            ? "未连接"
            : active.page === undefined
              ? "扩展已连接"
              : "页面已连接",
        ...(active?.extensionVersion === undefined
          ? {}
          : { extensionVersion: active.extensionVersion }),
        ...(active?.adapterVersion === undefined
          ? {}
          : { adapterVersion: active.adapterVersion }),
        capabilities: [...(active?.capabilities ?? [])],
        readOnlyCalibrated: active?.readOnlyCalibrated ?? false,
        preparation: { ...preparation },
        ...(active?.page === undefined ? {} : { page: { ...active.page } }),
      } satisfies ExtensionStatus;
    },
    setPreparationHandler(handler) {
      preparationHandler = handler;
    },
    resetPairing() {
      options.settings.setSetting<null>(PAIRING_SETTING_KEY, null);
      pendingAuthorization = undefined;
      setPreparation({
        state: "idle",
        stage: "connecting",
        message: "扩展授权已重置",
      });
      if (active !== undefined) {
        send(active.socket, { type: "disarm", reason: "扩展配对已重置" });
        active.socket.close(4401, "扩展配对已重置");
      }
      disconnectActive("扩展配对已重置");
    },
    calibrate(plan) {
      return executeCalibration(plan, commandTimeoutMs);
    },
    scan(plan) {
      return executePageCommand<ScanPlanResult>("read", (base) => ({
        ...base,
        type: "scan-plan",
        searchUrl: searchUrlFor(plan),
      }));
    },
    inspect(candidate) {
      return executePageCommand<InspectPositionResult>("read", (base) => ({
        ...base,
        type: "inspect-position",
        candidate,
      }));
    },
    sendOpening(request) {
      return executePageCommand<SendOpeningExecutionResult>(
        "batch-send",
        (base) => ({
          ...base,
          type: "send-opening",
          commandId: request.commandId,
          operationId: request.operationId,
          candidate: request.candidate,
          message: request.message,
          messageHash: request.messageHash,
        }),
      );
    },
    async waitUntilPageReady(onWaiting) {
      const connection = requireBoundConnection();
      if (connection.page!.active && connection.page!.visible) return;
      onWaiting();
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          if (active?.authenticated !== true || active.page === undefined) {
            clearInterval(interval);
            reject(new Error("等待页面期间连接已经断开"));
            return;
          }
          if (active.page.active && active.page.visible) {
            clearInterval(interval);
            resolve();
          }
        }, 250);
        interval.unref?.();
      });
    },
    emergencyStop(reason = "JobPilot 已紧急停止") {
      if (active !== undefined) {
        send(active.socket, { type: "disarm", reason });
        delete active.page;
        active.readOnlyCalibrated = false;
      }
      rejectPending(reason);
    },
    close() {
      clearInterval(heartbeatSweep);
      if (active !== undefined) {
        send(active.socket, { type: "disarm", reason: "JobPilot 已关闭" });
        active.socket.close(1001, "JobPilot 已关闭");
      }
      disconnectActive("JobPilot 已关闭");
    },
  };

  function executePageCommand<T>(
    capability: ExtensionCapability,
    build: (base: {
      commandId: string;
      connectionId: string;
      expectedTabId: number;
      expectedUrl: string;
      deadline: string;
    }) => ExtensionCommand,
    timeoutMs = commandTimeoutMs,
  ): Promise<T> {
    if (pendingCommands.size > 0) {
      return Promise.reject(new Error("已有扩展页面命令正在执行"));
    }
    const connection = requireBoundConnection();
    if (!connection.capabilities.includes(capability)) {
      return Promise.reject(new Error(`当前扩展不支持 ${capability} 能力`));
    }
    const command = build({
      commandId: randomUUID(),
      connectionId: connection.connectionId!,
      expectedTabId: connection.page!.tabId,
      expectedUrl: connection.page!.url,
      deadline: new Date(Date.now() + timeoutMs).toISOString(),
    });
    const legacyCalibration =
      connection.adapterVersion === 1 && command.type === "calibrate";
    if (
      connection.adapterVersion !== BOSS_ADAPTER_VERSION &&
      !legacyCalibration
    ) {
      return Promise.reject(new Error("Boss 页面适配器版本不兼容"));
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(command.commandId);
        reject(new Error(`扩展 ${command.type} 命令超时`));
      }, timeoutMs);
      pendingCommands.set(command.commandId, {
        kind: command.type,
        timeout,
        connectionId: connection.connectionId!,
        tabId: connection.page!.tabId,
        resolve: (result) => resolve(result as T),
        reject,
      });
      send(connection.socket, { type: "command", command });
    });
  }

  function executeCalibration(
    plan: SearchPlan,
    timeoutMs: number,
  ): Promise<CalibrationResult> {
    return executePageCommand<CalibrationResult>(
      "read",
      (base) => ({
        ...base,
        type: "calibrate",
        searchUrl: searchUrlFor(plan),
      }),
      timeoutMs,
    );
  }

  async function receive(raw: unknown): Promise<void> {
    if (active === undefined) return;
    active.lastSeenAt = Date.now();
    const text = rawToString(raw);
    if (Buffer.byteLength(text, "utf8") > EXTENSION_MESSAGE_LIMIT_BYTES) {
      active.socket.close(4400, "扩展消息过大");
      disconnectActive("扩展消息超过大小限制");
      return;
    }
    let message: ExtensionToServerMessage;
    try {
      message = parseClientMessage(JSON.parse(text) as unknown);
    } catch (error) {
      send(active.socket, {
        type: "error",
        code: "invalid_message",
        message: error instanceof Error ? error.message : "扩展消息无效",
      });
      return;
    }

    if (message.type === "heartbeat") {
      if (active.authenticated) return;
      send(active.socket, {
        type: "error",
        code: "not_authenticated",
        message: "扩展尚未完成配对认证",
      });
      return;
    }
    if (message.type === "hello") {
      if (active.instanceId !== undefined) {
        send(active.socket, {
          type: "error",
          code: "duplicate_hello",
          message: "扩展已经完成握手",
        });
        return;
      }
      receiveHello(message);
      return;
    }
    if (message.type === "prepare_page") {
      startPagePreparation(message.tab);
      return;
    }
    if (!active.authenticated) {
      send(active.socket, {
        type: "error",
        code: "not_authenticated",
        message: "扩展尚未完成配对认证",
      });
      return;
    }
    if (message.type === "page_state") {
      if (
        active.page !== undefined &&
        active.page.tabId === message.tab.tabId &&
        isBossUrl(message.tab.url)
      ) {
        const previous = active.page;
        if (changedAccount(previous, message.tab)) {
          active.readOnlyCalibrated = false;
        }
        active.page = { ...message.tab };
      } else {
        delete active.page;
        active.readOnlyCalibrated = false;
        setPreparation({
          state: "idle",
          stage: "connecting",
          message: "当前页面连接已失效",
        });
      }
      return;
    }
    if (message.type === "preparation_progress") {
      if (preparation.state === "running" && message.stage === "returning") {
        setPreparation({
          state: "running",
          stage: "returning",
          message: "正在返回搜索列表…",
        });
      }
      return;
    }
    if (message.type === "emergency_stop") {
      delete active.page;
      active.readOnlyCalibrated = false;
      setPreparation({
        state: "idle",
        stage: "connecting",
        message: "页面连接已解除",
      });
      rejectPending(message.reason ?? "扩展已经紧急停止");
      return;
    }
    receiveCommandResult(message);
  }

  function receiveHello(
    message: Extract<ExtensionToServerMessage, { type: "hello" }>,
  ): void {
    if (active === undefined) return;
    const currentProtocol =
      message.protocolVersion === EXTENSION_PROTOCOL_VERSION &&
      message.adapterVersion === BOSS_ADAPTER_VERSION;
    if (!currentProtocol) {
      setPreparation({
        state: "error",
        stage: "connecting",
        message: "扩展版本过旧",
        error: "请重新构建并加载最新扩展",
      });
      send(active.socket, {
        type: "error",
        code: "version_mismatch",
        message: "扩展协议或 Boss 适配器版本不兼容",
      });
      active.socket.close(4406, "扩展版本不兼容");
      disconnectActive("扩展版本不兼容");
      return;
    }
    active.instanceId = message.instanceId;
    active.extensionVersion = message.extensionVersion;
    active.adapterVersion = message.adapterVersion;
    active.capabilities = message.capabilities.filter((capability) =>
      SERVER_CAPABILITIES.includes(
        capability as (typeof SERVER_CAPABILITIES)[number],
      ),
    );
    const pairing = pairingRecord();
    if (pairing === undefined) {
      pendingAuthorization = {
        instanceId: message.instanceId,
      };
      send(active.socket, { type: "authorization_required" });
      publishPreparation();
      return;
    }
    if (
      pairing.instanceId !== message.instanceId ||
      message.challengeProof === undefined ||
      !proofMatches(
        pairing.pairingSecret,
        active.nonce,
        message.instanceId,
        message.challengeProof,
      )
    ) {
      send(active.socket, {
        type: "error",
        code: "pairing_rejected",
        message: "扩展实例与已批准配对不一致",
      });
      active.socket.close(4401, "扩展配对认证失败");
      disconnectActive("扩展配对认证失败");
      return;
    }
    active.authenticated = true;
    active.connectionId = randomUUID();
    send(active.socket, { type: "ready", connectionId: active.connectionId });
    publishPreparation();
  }

  function receiveCommandResult(
    message: Extract<ExtensionToServerMessage, { type: "command_result" }>,
  ): void {
    const pending = pendingCommands.get(message.commandId);
    if (pending === undefined) return;
    clearTimeout(pending.timeout);
    pendingCommands.delete(message.commandId);
    if (
      active?.connectionId !== pending.connectionId ||
      active.page?.tabId !== pending.tabId
    ) {
      pending.reject(new Error("扩展命令期间页面连接已经变化"));
      return;
    }
    if (message.outcome !== "ok") {
      const currentUrl = currentUrlFrom(message.data);
      if (currentUrl !== undefined && active?.page !== undefined) {
        active.page.url = currentUrl;
      }
      pending.reject(new Error(message.error ?? "扩展无法完成页面命令"));
      return;
    }
    if (!isCommandResult(pending.kind, message.data)) {
      pending.reject(new Error(`扩展返回的 ${pending.kind} 结果格式无效`));
      return;
    }
    pending.resolve(message.data);
    const currentUrl = (message.data as { currentUrl?: unknown }).currentUrl;
    if (typeof currentUrl === "string" && isBossUrl(currentUrl)) {
      active.page.url = currentUrl;
    }
    if (pending.kind === "calibrate") active.readOnlyCalibrated = true;
  }

  function startPagePreparation(tab: BoundBossPage): void {
    if (preparationPromise !== undefined) {
      if (preparationTabId === tab.tabId) publishPreparation();
      else {
        send(active!.socket, {
          type: "error",
          code: "preparation_busy",
          message: "另一张 BOSS 页面正在连接并检查",
        });
      }
      return;
    }
    if (active?.page !== undefined && active.page.tabId !== tab.tabId) {
      setPreparation({
        state: "error",
        stage: "binding",
        message: "已有另一张 BOSS 页面保持连接",
        error: "请先在 JobPilot 设置页解除现有页面连接",
      });
      return;
    }
    preparationTabId = tab.tabId;
    preparationPromise = preparePage(tab).finally(() => {
      preparationPromise = undefined;
      preparationTabId = undefined;
    });
  }

  async function preparePage(tab: BoundBossPage): Promise<void> {
    const deadline = Date.now() + 90_000;
    try {
      if (!isBossUrl(tab.url)) throw new Error("只能连接 Boss 官方页面");
      if (preparationHandler === undefined) {
        throw new Error("本机 JobPilot 尚未配置页面准备流程");
      }
      setPreparation({
        state: "running",
        stage: "authorizing",
        message: "正在授权扩展…",
      });
      const plan = await preparationHandler();
      if (active === undefined) throw new Error("扩展连接已经断开");
      if (!active.authenticated) authorizeCurrentExtension();
      if (active.page?.tabId === tab.tabId && active.readOnlyCalibrated) {
        setPreparation({
          state: "ready",
          stage: "ready",
          message: "页面已就绪",
        });
        return;
      }

      setPreparation({
        state: "running",
        stage: "binding",
        message: "正在连接当前页面…",
      });
      active.page = { ...tab };
      active.readOnlyCalibrated = false;
      send(active.socket, {
        type: "page_bound",
        connectionId: active.connectionId!,
        tabId: tab.tabId,
      });

      let result: CalibrationResult | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        setPreparation({
          state: "running",
          stage: "calibrating",
          message:
            attempt === 0 ? "正在检查页面…" : "页面响应中断，正在重试检查…",
        });
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("页面准备流程超时");
          result = await executeCalibration(plan, Math.min(40_000, remaining));
          break;
        } catch (error) {
          if (attempt > 0 || !isRetryablePreparationError(error)) throw error;
        }
      }
      if (result === undefined) throw new Error("页面只读校准失败");
      setPreparation({
        state: "ready",
        stage: "ready",
        message: `页面已就绪，识别到 ${result.candidatesRecognized} 个候选职位`,
        ...(result.returnWarning === undefined
          ? {}
          : { warning: result.returnWarning }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "页面准备失败";
      setPreparation({
        state: "error",
        stage: preparation.stage,
        message: "页面尚未就绪",
        error: message,
      });
    }
  }

  function authorizeCurrentExtension(): void {
    if (
      active === undefined ||
      pendingAuthorization === undefined ||
      active.instanceId !== pendingAuthorization.instanceId
    ) {
      throw new Error("扩展授权请求不存在或已经失效");
    }
    const pairingSecret = randomBytes(32).toString("base64url");
    options.settings.setSetting<ExtensionPairingRecord>(PAIRING_SETTING_KEY, {
      instanceId: pendingAuthorization.instanceId,
      pairingSecret,
      approvedAt: now().toISOString(),
    });
    active.authenticated = true;
    active.connectionId = randomUUID();
    pendingAuthorization = undefined;
    send(active.socket, {
      type: "pairing_accepted",
      pairingSecret,
      connectionId: active.connectionId,
    });
  }

  function setPreparation(status: PagePreparationStatus): void {
    preparation = status;
    publishPreparation();
  }

  function publishPreparation(): void {
    if (active !== undefined) {
      send(active.socket, {
        type: "preparation_state",
        status: { ...preparation },
      });
    }
  }

  function requireBoundConnection(): ActiveConnection {
    if (active?.authenticated !== true) {
      throw new Error("Chrome 扩展尚未连接");
    }
    if (active.page === undefined) {
      throw new Error("请先通过扩展连接当前 Boss 标签页");
    }
    return active;
  }

  function pairingRecord(): ExtensionPairingRecord | undefined {
    return (
      options.settings.getSetting<ExtensionPairingRecord | null>(
        PAIRING_SETTING_KEY,
        null,
      ) ?? undefined
    );
  }

  function disconnectActive(reason: string): void {
    active = undefined;
    pendingAuthorization = undefined;
    preparationPromise = undefined;
    preparationTabId = undefined;
    rejectPending(reason);
  }

  function rejectPending(reason: string): void {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    pendingCommands.clear();
  }
}

function send(socket: BridgeSocket, message: ServerToExtensionMessage): void {
  socket.send(JSON.stringify(message));
}

function proofMatches(
  secret: string,
  nonce: string,
  instanceId: string,
  proof: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(`${nonce}:${instanceId}`)
    .digest();
  let received: Buffer;
  try {
    received = Buffer.from(proof, "base64url");
  } catch {
    return false;
  }
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

function rawToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return String(raw);
}

function currentUrlFrom(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.currentUrl !== "string")
    return undefined;
  return isBossUrl(value.currentUrl) ? value.currentUrl : undefined;
}

function isRetryablePreparationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/登录|验证|风控|版本|不兼容|结构不受支持|未识别到|只能连接|页面已经变化|不属于当前|已有/.test(
    message,
  );
}

function parseClientMessage(value: unknown): ExtensionToServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("扩展消息缺少类型");
  }
  if (value.type === "heartbeat") return { type: "heartbeat" };
  if (value.type === "hello") {
    if (
      !isFiniteInteger(value.protocolVersion) ||
      !isFiniteInteger(value.adapterVersion) ||
      !isShortString(value.extensionVersion, 40) ||
      !isShortString(value.instanceId, 100) ||
      !Array.isArray(value.capabilities) ||
      !value.capabilities.every(isCapability) ||
      (value.challengeProof !== undefined &&
        !isShortString(value.challengeProof, 200))
    ) {
      throw new Error("扩展握手消息格式无效");
    }
    return value as unknown as ExtensionToServerMessage;
  }
  if (value.type === "prepare_page" || value.type === "page_state") {
    if (!isBoundPage(value.tab)) throw new Error("扩展页面状态格式无效");
    return value as unknown as ExtensionToServerMessage;
  }
  if (value.type === "preparation_progress") {
    if (value.stage !== "returning") {
      throw new Error("扩展页面准备进度格式无效");
    }
    return { type: "preparation_progress", stage: "returning" };
  }
  if (value.type === "command_result") {
    if (
      !isShortString(value.commandId, 100) ||
      !["ok", "error", "takeover"].includes(String(value.outcome)) ||
      (value.error !== undefined && !isShortString(value.error, 1_000))
    ) {
      throw new Error("扩展命令结果格式无效");
    }
    return value as unknown as ExtensionToServerMessage;
  }
  if (value.type === "emergency_stop") {
    if (value.reason !== undefined && !isShortString(value.reason, 500)) {
      throw new Error("扩展停止原因格式无效");
    }
    return value as unknown as ExtensionToServerMessage;
  }
  throw new Error("扩展消息类型无效");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isShortString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isCapability(value: unknown): boolean {
  return ["read", "batch-send"].includes(String(value));
}

function isBoundPage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isFiniteInteger(value.tabId) &&
    value.tabId >= 0 &&
    isShortString(value.url, 4_096) &&
    typeof value.active === "boolean" &&
    typeof value.visible === "boolean" &&
    (value.accountDisplayName === undefined ||
      isShortString(value.accountDisplayName, 200)) &&
    (value.accountFingerprint === undefined ||
      isShortString(value.accountFingerprint, 200))
  );
}

function isBossUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "zhipin.com" || hostname.endsWith(".zhipin.com");
  } catch {
    return false;
  }
}

function changedAccount(previous: BoundBossPage, next: BoundBossPage): boolean {
  if (
    previous.accountFingerprint !== undefined &&
    next.accountFingerprint !== undefined
  ) {
    return previous.accountFingerprint !== next.accountFingerprint;
  }
  return (
    previous.accountDisplayName !== undefined &&
    next.accountDisplayName !== undefined &&
    previous.accountDisplayName !== next.accountDisplayName
  );
}

function isCalibrationResult(value: unknown): value is CalibrationResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.candidatesRecognized === "number" &&
    Number.isInteger(result.candidatesRecognized) &&
    result.candidatesRecognized >= 0 &&
    typeof result.currentUrl === "string" &&
    isBossUrl(result.currentUrl) &&
    ["可沟通", "平台已沟通", "未知状态"].includes(String(result.contactState))
  );
}

function isCommandResult(
  kind: ExtensionCommand["type"],
  value: unknown,
): boolean {
  if (kind === "calibrate") return isCalibrationResult(value);
  if (!isRecord(value)) return false;
  if (!isShortString(value.currentUrl, 4_096) || !isBossUrl(value.currentUrl)) {
    return false;
  }
  if (kind === "scan-plan") {
    return (
      Array.isArray(value.candidates) && value.candidates.every(isCandidate)
    );
  }
  if (kind === "inspect-position") {
    return (
      isCandidate(value.candidate) &&
      ["可沟通", "平台已沟通", "未知状态"].includes(String(value.contactState))
    );
  }
  const result = String(value.result);
  if (
    !["沟通成功", "结果未知", "明确未开始", "内容不符"].includes(result) ||
    typeof value.irreversibleStarted !== "boolean"
  ) {
    return false;
  }
  if (value.evidence !== undefined) {
    if (!isRecord(value.evidence)) return false;
    const evidence = value.evidence;
    if (
      !Number.isSafeInteger(evidence.baselineOutgoingCount) ||
      Number(evidence.baselineOutgoingCount) < 0 ||
      !Number.isSafeInteger(evidence.finalOutgoingCount) ||
      Number(evidence.finalOutgoingCount) < 0 ||
      (evidence.confirmation !== undefined &&
        !["matched-message", "boss-success-dialog"].includes(
          String(evidence.confirmation),
        )) ||
      (evidence.matchedMessageHash !== undefined &&
        !/^[a-f0-9]{64}$/.test(String(evidence.matchedMessageHash)))
    ) {
      return false;
    }
    if (
      result === "沟通成功" &&
      !["matched-message", "boss-success-dialog"].includes(
        String(evidence.confirmation),
      )
    ) {
      return false;
    }
  } else if (result === "沟通成功") {
    return false;
  }
  if (value.takeover !== undefined) {
    if (
      result !== "沟通成功" ||
      !isRecord(value.takeover) ||
      !["login", "verification"].includes(String(value.takeover.kind)) ||
      !isShortString(value.takeover.reason, 1_000)
    ) {
      return false;
    }
  }
  return true;
}

function isCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isShortString(value.title, 500) &&
    isShortString(value.company, 500) &&
    (value.id === undefined || isShortString(value.id, 500)) &&
    (value.url === undefined || isShortString(value.url, 4_096))
  );
}

function searchUrlFor(plan: SearchPlan): string {
  const keyword = plan.rules.titleKeywords[0] ?? "";
  return `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}`;
}
