import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createExtensionBridge } from "../../src/extension/bridge.ts";
import {
  BOSS_ADAPTER_VERSION,
  EXTENSION_PROTOCOL_VERSION,
  type ServerToExtensionMessage,
} from "../../src/extension/protocol.ts";

describe("Chrome extension bridge", () => {
  it("pairs one installation, binds one Boss tab, and completes calibration", async () => {
    const settings = new Map<string, unknown>();
    const bridge = createExtensionBridge({
      settings: memorySettings(settings),
      commandTimeoutMs: 1_000,
    });
    const socket = new FakeSocket();
    bridge.setPreparationHandler?.(async () => ({
      id: "go-beijing",
      name: "北京 Go",
      enabled: true,
      priority: 10,
      templateId: "default",
      rules: {
        titleKeywords: ["Go"],
        cities: ["北京"],
        companyBlacklist: [],
        industryBlacklist: [],
        allowRemote: false,
      },
    }));

    bridge.attach(socket);
    const challenge = socket.last("challenge");
    await socket.receive({
      type: "hello",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: "0.1.0",
      adapterVersion: BOSS_ADAPTER_VERSION,
      instanceId: "extension-instance-1",
      capabilities: ["read", "batch-send"],
    });

    const pending = bridge.getStatus();
    expect(pending.pairingState).toBe("等待授权");
    await socket.receive({
      type: "prepare_page",
      tab: {
        tabId: 42,
        url: "https://www.zhipin.com/web/geek/job",
        active: false,
        visible: false,
        accountDisplayName: "本人账号",
      },
    });
    await vi.waitFor(() => expect(socket.last("command")).toBeDefined());
    const paired = socket.last("pairing_accepted");
    expect(paired.pairingSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(bridge.getStatus()).toMatchObject({
      pairingState: "已授权",
      connectionState: "页面已连接",
      capabilities: ["read", "batch-send"],
      page: { tabId: 42, accountDisplayName: "本人账号" },
    });

    const command = socket.last("command");
    expect(command).toMatchObject({
      command: {
        type: "calibrate",
        expectedTabId: 42,
        searchUrl: "https://www.zhipin.com/web/geek/job?query=Go",
      },
    });
    await socket.receive({
      type: "command_result",
      commandId: command.command.commandId,
      outcome: "ok",
      data: {
        candidatesRecognized: 12,
        currentUrl: "https://www.zhipin.com/job_detail/abc.html",
        contactState: "可沟通",
      },
    });

    await vi.waitFor(() => {
      expect(bridge.getStatus()).toMatchObject({
        readOnlyCalibrated: true,
        preparation: { state: "ready", stage: "ready" },
      });
    });
    await socket.receive({
      type: "page_state",
      tab: {
        tabId: 42,
        url: "https://www.zhipin.com/web/geek/recommend",
        active: true,
        visible: true,
        accountDisplayName: "本人账号",
      },
    });
    expect(bridge.getStatus().readOnlyCalibrated).toBe(true);
    bridge.close();
    expect(challenge.nonce).toHaveLength(43);
  });

  it("rejects extensions that do not support the one-step protocol", async () => {
    const bridge = createExtensionBridge({
      settings: memorySettings(new Map()),
      commandTimeoutMs: 1_000,
    });
    const socket = new FakeSocket();

    bridge.attach(socket);
    expect(socket.last("challenge")).toMatchObject({
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
    });
    await socket.receive({
      type: "hello",
      protocolVersion: 1,
      extensionVersion: "0.0.9",
      adapterVersion: 1,
      instanceId: "legacy-extension",
      capabilities: ["read"],
    });
    expect(socket.closed).toEqual({ code: 4406, reason: "扩展版本不兼容" });
    expect(bridge.getStatus().preparation).toMatchObject({
      state: "error",
      error: "请重新构建并加载最新扩展",
    });
    bridge.close();
  });

  it("authenticates a previously paired installation with the server challenge", async () => {
    const secret = "paired-secret";
    const settings = new Map<string, unknown>([
      [
        "extensionPairing",
        {
          instanceId: "extension-instance-1",
          pairingSecret: secret,
          approvedAt: "2026-08-25T00:00:00.000Z",
        },
      ],
    ]);
    const bridge = createExtensionBridge({
      settings: memorySettings(settings),
    });
    const socket = new FakeSocket();

    bridge.attach(socket);
    const challenge = socket.last("challenge");
    await socket.receive({
      type: "hello",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: "0.1.0",
      adapterVersion: BOSS_ADAPTER_VERSION,
      instanceId: "extension-instance-1",
      capabilities: ["read"],
      challengeProof: createHmac("sha256", secret)
        .update(`${challenge.nonce}:extension-instance-1`)
        .digest("base64url"),
    });

    expect(socket.last("ready")).toMatchObject({ type: "ready" });
    expect(bridge.getStatus()).toMatchObject({
      pairingState: "已授权",
      connectionState: "扩展已连接",
    });
    bridge.close();
  });

  it("rejects a second socket while another extension is connected", () => {
    const bridge = createExtensionBridge({
      settings: memorySettings(new Map()),
    });
    const first = new FakeSocket();
    const second = new FakeSocket();

    bridge.attach(first);
    bridge.attach(second);

    expect(second.closed).toEqual({ code: 4409, reason: "已有扩展连接" });
    bridge.close();
  });

  it("does not authorize when page preparation prerequisites fail", async () => {
    const bridge = createExtensionBridge({
      settings: memorySettings(new Map()),
      commandTimeoutMs: 1_000,
    });
    bridge.setPreparationHandler?.(async () => {
      throw new Error("没有已启用的搜索方案，请先在 JobPilot 中启用一个方案");
    });
    const socket = new FakeSocket();
    bridge.attach(socket);
    await socket.receive({
      type: "hello",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: "0.2.0",
      adapterVersion: BOSS_ADAPTER_VERSION,
      instanceId: "extension-instance-1",
      capabilities: ["read", "batch-send"],
    });
    await socket.receive({
      type: "prepare_page",
      tab: {
        tabId: 42,
        url: "https://www.zhipin.com/web/geek/job",
        active: true,
        visible: true,
      },
    });

    await vi.waitFor(() => {
      expect(bridge.getStatus()).toMatchObject({
        pairingState: "等待授权",
        connectionState: "未连接",
        preparation: {
          state: "error",
          error: "没有已启用的搜索方案，请先在 JobPilot 中启用一个方案",
        },
      });
    });
    expect(
      socket.sent.some((message) => message.type === "pairing_accepted"),
    ).toBe(false);
    bridge.close();
  });

  it("fails an in-flight calibration when the extension disconnects", async () => {
    const secret = "paired-secret";
    const bridge = createExtensionBridge({
      settings: memorySettings(
        new Map([
          [
            "extensionPairing",
            {
              instanceId: "extension-instance-1",
              pairingSecret: secret,
              approvedAt: "2026-08-25T00:00:00.000Z",
            },
          ],
        ]),
      ),
      commandTimeoutMs: 1_000,
    });
    const socket = new FakeSocket();
    bridge.setPreparationHandler?.(async () => ({
      id: "plan",
      name: "方案",
      enabled: true,
      priority: 1,
      templateId: "template",
      rules: {
        titleKeywords: ["Go"],
        cities: ["北京"],
        companyBlacklist: [],
        industryBlacklist: [],
        allowRemote: false,
      },
    }));
    bridge.attach(socket);
    const challenge = socket.last("challenge");
    await socket.receive({
      type: "hello",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      extensionVersion: "0.1.0",
      adapterVersion: BOSS_ADAPTER_VERSION,
      instanceId: "extension-instance-1",
      capabilities: ["read"],
      challengeProof: createHmac("sha256", secret)
        .update(`${challenge.nonce}:extension-instance-1`)
        .digest("base64url"),
    });
    await socket.receive({
      type: "prepare_page",
      tab: {
        tabId: 8,
        url: "https://www.zhipin.com/web/geek/job",
        active: true,
        visible: true,
      },
    });
    await vi.waitFor(() => expect(socket.last("command")).toBeDefined());
    await socket.disconnect();

    await vi.waitFor(() => {
      expect(bridge.getStatus().preparation).toMatchObject({
        state: "error",
        error: expect.stringMatching(/扩展.*连接|Chrome 扩展尚未连接/),
      });
    });
    bridge.close();
  });
});

function memorySettings(values: Map<string, unknown>) {
  return {
    getSetting<T>(key: string, fallback: T): T {
      return (values.get(key) as T | undefined) ?? fallback;
    },
    setSetting<T>(key: string, value: T): void {
      values.set(key, value);
    },
  };
}

class FakeSocket {
  readonly sent: ServerToExtensionMessage[] = [];
  closed?: { code: number; reason: string };
  private readonly messageListeners: Array<
    (message: string) => Promise<void> | void
  > = [];
  private readonly closeListeners: Array<() => Promise<void> | void> = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as ServerToExtensionMessage);
  }

  close(code = 1000, reason = ""): void {
    this.closed = { code, reason };
  }

  on(
    event: "message" | "close",
    listener: ((message: string) => Promise<void> | void) | (() => void),
  ): this {
    if (event === "message") {
      this.messageListeners.push(listener as (message: string) => void);
    } else {
      this.closeListeners.push(listener as () => void);
    }
    return this;
  }

  async receive(message: unknown): Promise<void> {
    for (const listener of this.messageListeners) {
      await listener(JSON.stringify(message));
    }
  }

  async disconnect(): Promise<void> {
    for (const listener of this.closeListeners) await listener();
  }

  last<T extends ServerToExtensionMessage["type"]>(
    type: T,
  ): Extract<ServerToExtensionMessage, { type: T }> {
    const message = [...this.sent]
      .reverse()
      .find((candidate) => candidate.type === type);
    if (message === undefined) throw new Error(`没有找到 ${type} 消息`);
    return message as Extract<ServerToExtensionMessage, { type: T }>;
  }
}
