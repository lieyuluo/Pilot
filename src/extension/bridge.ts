import {
  createHmac,
  randomBytes,
  randomInt,
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
  approvePairing(requestId: string): Promise<void>;
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

interface PendingPairing {
  requestId: string;
  code: string;
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
  let pendingPairing: PendingPairing | undefined;
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
        // Keep the v1 handshake envelope so an installed v1 extension can
        // authenticate for read-only use; hello negotiates the real protocol.
        protocolVersion: 1,
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
            ? "已配对"
            : pendingPairing === undefined
              ? "未配对"
              : "等待批准",
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
        ...(pendingPairing === undefined
          ? {}
          : {
              pendingPairing: {
                requestId: pendingPairing.requestId,
                code: pendingPairing.code,
              },
            }),
        ...(active?.page === undefined ? {} : { page: { ...active.page } }),
      } satisfies ExtensionStatus;
    },
    async approvePairing(requestId) {
      if (
        active === undefined ||
        pendingPairing === undefined ||
        pendingPairing.requestId !== requestId
      ) {
        throw new Error("配对请求不存在或已经失效");
      }
      const pairingSecret = randomBytes(32).toString("base64url");
      options.settings.setSetting<ExtensionPairingRecord>(PAIRING_SETTING_KEY, {
        instanceId: pendingPairing.instanceId,
        pairingSecret,
        approvedAt: now().toISOString(),
      });
      active.authenticated = true;
      active.connectionId = randomUUID();
      pendingPairing = undefined;
      send(active.socket, {
        type: "pairing_accepted",
        pairingSecret,
        connectionId: active.connectionId,
      });
    },
    resetPairing() {
      options.settings.setSetting<null>(PAIRING_SETTING_KEY, null);
      pendingPairing = undefined;
      if (active !== undefined) {
        send(active.socket, { type: "disarm", reason: "扩展配对已重置" });
        active.socket.close(4401, "扩展配对已重置");
      }
      disconnectActive("扩展配对已重置");
    },
    calibrate(plan) {
      return executePageCommand<CalibrationResult>("read", (base) => ({
        ...base,
        type: "calibrate",
        searchUrl: searchUrlFor(plan),
      }));
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
      deadline: new Date(Date.now() + commandTimeoutMs).toISOString(),
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
      }, commandTimeoutMs);
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
    if (!active.authenticated) {
      send(active.socket, {
        type: "error",
        code: "not_authenticated",
        message: "扩展尚未完成配对认证",
      });
      return;
    }
    if (message.type === "bind_page") {
      if (!isBossUrl(message.tab.url)) {
        send(active.socket, {
          type: "error",
          code: "unsupported_page",
          message: "只能连接 Boss 官方页面",
        });
        return;
      }
      active.page = { ...message.tab };
      active.readOnlyCalibrated = false;
      send(active.socket, {
        type: "page_bound",
        connectionId: active.connectionId!,
        tabId: message.tab.tabId,
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
      }
      return;
    }
    if (message.type === "emergency_stop") {
      delete active.page;
      active.readOnlyCalibrated = false;
      rejectPending(message.reason ?? "扩展已经紧急停止");
      return;
    }
    receiveCommandResult(message);
  }

  function receiveHello(
    message: Extract<ExtensionToServerMessage, { type: "hello" }>,
  ): void {
    if (active === undefined) return;
    const legacyReadOnly =
      message.protocolVersion === 1 && message.adapterVersion === 1;
    const currentProtocol =
      message.protocolVersion === EXTENSION_PROTOCOL_VERSION &&
      message.adapterVersion === BOSS_ADAPTER_VERSION;
    if (!legacyReadOnly && !currentProtocol) {
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
    active.capabilities = legacyReadOnly
      ? message.capabilities.includes("read")
        ? ["read"]
        : []
      : message.capabilities.filter((capability) =>
          SERVER_CAPABILITIES.includes(
            capability as (typeof SERVER_CAPABILITIES)[number],
          ),
        );
    const pairing = pairingRecord();
    if (pairing === undefined) {
      pendingPairing = {
        requestId: randomUUID(),
        code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
        instanceId: message.instanceId,
      };
      send(active.socket, {
        type: "pairing_required",
        requestId: pendingPairing.requestId,
        code: pendingPairing.code,
      });
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
    pendingPairing = undefined;
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
  if (value.type === "bind_page" || value.type === "page_state") {
    if (!isBoundPage(value.tab)) throw new Error("扩展页面状态格式无效");
    return value as unknown as ExtensionToServerMessage;
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
