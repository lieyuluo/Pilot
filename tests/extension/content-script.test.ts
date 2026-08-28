import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Chrome extension content script", () => {
  it("成功回执触发页面跳转前先返回不可降级的沟通成功", async () => {
    const window = new Window({
      url: "https://www.zhipin.com/job_detail/abc123.html",
    });
    window.document.write(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
        <section id="chat" class="chat-panel" hidden>
          <textarea id="message"></textarea>
          <button id="send">发送</button>
          <div class="message-list"><p class="item-myself">平台默认招呼</p></div>
        </section>
      </main>
    `);
    let runtimeListener:
      | ((
          message: unknown,
          sender: unknown,
          respond: (value: unknown) => void,
        ) => boolean)
      | undefined;
    const runtime = {
      onMessage: {
        addListener: vi.fn((listener) => {
          runtimeListener = listener;
        }),
      },
      sendMessage: vi.fn(async () => undefined),
    };
    let continued = false;
    window.document.querySelector("#contact")!.addEventListener("click", () => {
      const dialog = window.document.createElement("section");
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML = `
        <h2>已向BOSS发送消息</h2>
        <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
        <button id="continue">继续沟通</button>
      `;
      window.document.body.append(dialog);
      dialog.querySelector("#continue")!.addEventListener("click", () => {
        continued = true;
        dialog.remove();
        (
          window.document.querySelector("#chat") as unknown as HTMLElement
        ).hidden = false;
      });
    });
    window.document.querySelector("#send")!.addEventListener("click", () => {
      const item = window.document.createElement("p");
      item.className = "item-myself";
      item.textContent = (
        window.document.querySelector(
          "#message",
        ) as unknown as HTMLTextAreaElement
      ).value;
      window.document.querySelector(".message-list")!.append(item);
    });
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("location", window.location);
    vi.stubGlobal("chrome", { runtime });

    await import("../../src/extension/content-script.ts");

    let responseAttempts = 0;
    const outcome = await new Promise<Record<string, unknown>>((resolve) => {
      const keptOpen = runtimeListener?.(
        { type: "send_opening", message: "您好，想进一步沟通。" },
        {},
        (value) => {
          responseAttempts += 1;
          resolve(
            continued
              ? {
                  result: "结果未知",
                  irreversibleStarted: true,
                  error: "页面跳转使响应通道中断",
                }
              : (value as Record<string, unknown>),
          );
        },
      );
      expect(keptOpen).toBe(true);
    });

    await vi.waitFor(() => expect(continued).toBe(true));
    expect(outcome).toMatchObject({
      result: "沟通成功",
      confirmation: "boss-success-dialog",
      irreversibleStarted: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(responseAttempts).toBe(1);
    window.close();
  });

  it("成功回执的首次响应抛错后仍用最终成功结果重试响应", async () => {
    const window = new Window({
      url: "https://www.zhipin.com/job_detail/abc123.html",
    });
    window.document.write(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
      </main>
    `);
    let runtimeListener:
      | ((
          message: unknown,
          sender: unknown,
          respond: (value: unknown) => void,
        ) => boolean)
      | undefined;
    const runtime = {
      onMessage: {
        addListener: vi.fn((listener) => {
          runtimeListener = listener;
        }),
      },
      sendMessage: vi.fn(async () => undefined),
    };
    window.document.querySelector("#contact")!.addEventListener("click", () => {
      const dialog = window.document.createElement("section");
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML = `
        <h2>已向BOSS发送消息</h2>
        <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
      `;
      window.document.body.append(dialog);
    });
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("location", window.location);
    vi.stubGlobal("chrome", { runtime });

    await import("../../src/extension/content-script.ts");

    let responseAttempts = 0;
    const outcome = await new Promise<Record<string, unknown>>((resolve) => {
      const keptOpen = runtimeListener?.(
        { type: "send_opening", message: "您好，想进一步沟通。" },
        {},
        (value) => {
          responseAttempts += 1;
          if (responseAttempts === 1) {
            throw new Error("simulated response failure");
          }
          resolve(value as Record<string, unknown>);
        },
      );
      expect(keptOpen).toBe(true);
    });

    expect(outcome).toMatchObject({
      result: "沟通成功",
      confirmation: "boss-success-dialog",
      irreversibleStarted: true,
    });
    expect(responseAttempts).toBe(2);
    window.close();
  });

  it("扩展重载使旧页面上下文失效后不再发送页面状态", async () => {
    const window = new Window({
      url: "https://www.zhipin.com/web/geek/job",
    });
    const runtime = {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => undefined),
    };
    const chromeStub: { runtime?: typeof runtime } = { runtime };
    let invokeVisibilityListener: (() => void) | undefined;
    const addEventListener = window.document.addEventListener.bind(
      window.document,
    );
    vi.spyOn(window.document, "addEventListener").mockImplementation(
      (type, listener, options) => {
        if (type === "visibilitychange" && typeof listener === "function") {
          invokeVisibilityListener = () =>
            listener(new window.Event("visibilitychange"));
        }
        addEventListener(type, listener, options);
      },
    );
    vi.stubGlobal("document", window.document);
    vi.stubGlobal("location", window.location);
    vi.stubGlobal("chrome", chromeStub);

    await import("../../src/extension/content-script.ts");
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    runtime.sendMessage.mockImplementation(() => {
      throw new Error("Extension context invalidated.");
    });
    expect(() => invokeVisibilityListener!()).not.toThrow();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);

    delete chromeStub.runtime;

    expect(invokeVisibilityListener).toBeDefined();
    expect(() => invokeVisibilityListener!()).not.toThrow();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    window.close();
  });
});
