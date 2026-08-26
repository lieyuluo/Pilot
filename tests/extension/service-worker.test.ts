import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BOSS_ADAPTER_VERSION,
  EXTENSION_PROTOCOL_VERSION,
} from "../../src/extension/protocol.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Chrome extension service worker", () => {
  it("等待已完成导航的搜索页渲染出职位列表", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends FakeWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;

        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    );

    let currentUrl = "https://www.zhipin.com/?ka=header-home-logo";
    let listReads = 0;
    const storage = new Map<string, unknown>([
      ["jobpilotInstanceId", "extension-instance-1"],
    ]);
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "0.1.0" }),
        onStartup: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          async get(key: string) {
            return { [key]: storage.get(key) };
          },
          async set(values: Record<string, unknown>) {
            for (const [key, value] of Object.entries(values)) {
              storage.set(key, value);
            }
          },
          async remove(key: string) {
            storage.delete(key);
          },
        },
      },
      tabs: {
        async get(tabId: number) {
          return {
            id: tabId,
            url: currentUrl,
            active: false,
            status: "complete",
          };
        },
        async update(_tabId: number, update: { url?: string }) {
          if (update.url !== undefined) currentUrl = update.url;
          return { url: currentUrl, active: false, status: "complete" };
        },
        async sendMessage(_tabId: number, message: { type: string }) {
          if (message.type === "read_candidates") {
            listReads += 1;
            if (listReads === 1) {
              return {
                inspection: {
                  kind: "unsupported",
                  url: currentUrl,
                  candidatesRecognized: 0,
                },
                candidates: [],
              };
            }
            if (listReads === 2) {
              return {
                inspection: {
                  kind: "list",
                  url: currentUrl,
                  candidatesRecognized: 1,
                },
                candidates: [],
              };
            }
            return {
              inspection: {
                kind: "list",
                url: currentUrl,
                candidatesRecognized: 1,
              },
              candidates: [
                {
                  id: "abc123",
                  url: "https://www.zhipin.com/job_detail/abc123.html",
                  title: "Go 后端开发工程师",
                  company: "远山云计算",
                },
              ],
            };
          }
          if (message.type === "read_contact_state") {
            return {
              inspection: {
                kind: "detail",
                url: currentUrl,
                candidatesRecognized: 0,
              },
              contactState: "可沟通",
            };
          }
          throw new Error(`unexpected tab message: ${message.type}`);
        },
        query: vi.fn(),
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });

    await import("../../src/extension/service-worker.ts");
    const socket = sockets[0]!;
    socket.receive({
      type: "challenge",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      nonce: "challenge-nonce",
    });
    await vi.waitFor(() => {
      expect(socket.last("hello")).toBeDefined();
    });
    socket.receive({ type: "ready", connectionId: "connection-1" });
    socket.receive({
      type: "page_bound",
      connectionId: "connection-1",
      tabId: 42,
    });
    socket.receive({
      type: "command",
      command: {
        type: "calibrate",
        commandId: "command-1",
        connectionId: "connection-1",
        expectedTabId: 42,
        expectedUrl: currentUrl,
        deadline: new Date(Date.now() + 10_000).toISOString(),
        searchUrl: "https://www.zhipin.com/web/geek/job?query=Go",
      },
    });

    await vi.waitFor(() => {
      expect(socket.last("command_result")).toMatchObject({
        outcome: "ok",
        data: {
          candidatesRecognized: 1,
          currentUrl: "https://www.zhipin.com/web/geek/job?query=Go",
          contactState: "可沟通",
        },
      });
    });
    expect(listReads).toBe(3);
    expect(BOSS_ADAPTER_VERSION).toBe(3);
  });

  it("一次用户点击只发送一个页面准备请求", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends FakeWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    );
    let runtimeListener:
      | ((
          message: unknown,
          sender: unknown,
          respond: (value: unknown) => void,
        ) => boolean)
      | undefined;
    const storage = new Map<string, unknown>([
      ["jobpilotInstanceId", "extension-instance-1"],
    ]);
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "0.2.0" }),
        onStartup: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onMessage: {
          addListener: vi.fn((listener) => {
            runtimeListener = listener;
          }),
        },
      },
      storage: {
        local: {
          async get(key: string) {
            return { [key]: storage.get(key) };
          },
          async set(values: Record<string, unknown>) {
            for (const [key, value] of Object.entries(values))
              storage.set(key, value);
          },
          async remove(key: string) {
            storage.delete(key);
          },
        },
      },
      tabs: {
        async query() {
          return [
            {
              id: 42,
              url: "https://www.zhipin.com/web/geek/job",
              active: true,
            },
          ];
        },
        async sendMessage() {
          return {
            kind: "list",
            url: "https://www.zhipin.com/web/geek/job",
            candidatesRecognized: 1,
            accountDisplayName: "本人账号",
          };
        },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    await import("../../src/extension/service-worker.ts");
    const socket = sockets[0]!;
    socket.receive({
      type: "challenge",
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      nonce: "challenge-nonce",
    });
    await vi.waitFor(() => expect(socket.last("hello")).toBeDefined());
    socket.receive({ type: "authorization_required" });
    const invoke = () =>
      new Promise((resolve) => {
        runtimeListener?.({ type: "prepare_current_page" }, {}, resolve);
      });
    const first = invoke();
    const second = invoke();
    await Promise.all([first, second]);

    expect(
      socket.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "prepare_page",
      ),
    ).toHaveLength(1);
  });

  it("服务工作线程重启后复用持久化终态，不重复执行发送命令", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends FakeWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;

        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    );
    const currentUrl = "https://www.zhipin.com/job_detail/abc123.html";
    const storage = new Map<string, unknown>([
      ["jobpilotInstanceId", "extension-instance-1"],
    ]);
    let sends = 0;
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "0.1.0" }),
        onStartup: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          async get(key: string) {
            return { [key]: storage.get(key) };
          },
          async set(values: Record<string, unknown>) {
            for (const [key, value] of Object.entries(values))
              storage.set(key, value);
          },
          async remove(key: string) {
            storage.delete(key);
          },
        },
      },
      tabs: {
        async get(tabId: number) {
          return {
            id: tabId,
            url: currentUrl,
            active: true,
            status: "complete",
          };
        },
        async sendMessage(_tabId: number, message: { type: string }) {
          expect(message.type).toBe("send_opening");
          sends += 1;
          return {
            inspection: {
              kind: "verification",
              url: currentUrl,
              candidatesRecognized: 0,
            },
            result: "沟通成功",
            irreversibleStarted: true,
            baselineOutgoingCount: 0,
            finalOutgoingCount: 1,
            confirmation: "boss-success-dialog",
          };
        },
        query: vi.fn(),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    const command = {
      type: "send-opening",
      commandId: "durable-command-1",
      operationId: "operation-1",
      connectionId: "connection-1",
      expectedTabId: 42,
      expectedUrl: currentUrl,
      deadline: new Date(Date.now() + 10_000).toISOString(),
      candidate: {
        id: "abc123",
        url: currentUrl,
        title: "Go 后端工程师",
        company: "远山云计算",
      },
      message: "您好，想进一步沟通。",
      messageHash: "a".repeat(64),
    } as const;

    await import("../../src/extension/service-worker.ts");
    await bind(sockets[0]!);
    sockets[0]!.receive({ type: "command", command });
    await vi.waitFor(() => {
      expect(sockets[0]!.last("command_result")).toMatchObject({
        commandId: command.commandId,
        outcome: "ok",
        data: {
          result: "沟通成功",
          evidence: { confirmation: "boss-success-dialog" },
          takeover: {
            kind: "verification",
            reason: "Boss 页面出现验证或风控提示",
          },
        },
      });
    });
    expect(
      (
        sockets[0]!.last("command_result") as {
          data: { evidence: Record<string, unknown> };
        }
      ).data.evidence,
    ).not.toHaveProperty("matchedMessageHash");
    expect(sends).toBe(1);

    vi.resetModules();
    await import("../../src/extension/service-worker.ts");
    await bind(sockets[1]!);
    sockets[1]!.receive({ type: "command", command });
    await vi.waitFor(() => {
      expect(sockets[1]!.last("command_result")).toMatchObject({
        commandId: command.commandId,
        outcome: "ok",
        data: { result: "沟通成功" },
      });
    });
    expect(sends).toBe(1);

    async function bind(socket: FakeWebSocket) {
      socket.receive({
        type: "challenge",
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        nonce: "challenge-nonce",
      });
      await vi.waitFor(() => expect(socket.last("hello")).toBeDefined());
      socket.receive({ type: "ready", connectionId: "connection-1" });
      socket.receive({
        type: "page_bound",
        connectionId: "connection-1",
        tabId: 42,
      });
    }
  });
});

class FakeWebSocket {
  readonly readyState = 1;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  constructor(readonly url: string) {}

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as unknown);
  }

  close(): void {}

  receive(message: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }

  last(type: string): unknown {
    return [...this.sent]
      .reverse()
      .find(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === type,
      );
  }
}
