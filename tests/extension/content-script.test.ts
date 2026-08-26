import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Chrome extension content script", () => {
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
