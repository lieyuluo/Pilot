import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import {
  appendOpeningTemplateFromDocument,
  inspectBossPage,
  readCandidates,
  readContactState,
  sendOpeningFromDocument,
} from "../../src/extension/boss-dom.ts";

describe("Boss extension DOM reader", () => {
  it("returns normalized candidates without returning raw HTML", () => {
    const window = fixtureWindow("job-list.html");

    const candidates = readCandidates(
      asBrowserDocument(window),
      "https://www.zhipin.com/web/geek/job",
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        id: "abc123",
        url: "https://www.zhipin.com/job_detail/abc123.html",
        title: "Go 后端开发工程师",
        company: "远山云计算",
        city: "北京",
        region: "海淀区",
        salaryMinK: 25,
        salaryMaxK: 40,
        experienceMinYears: 3,
        education: "本科",
        industry: "计算机软件",
      }),
      expect.objectContaining({
        id: "def456",
        experienceMinYears: 0,
        education: "硕士",
      }),
    ]);
    expect(JSON.stringify(candidates)).not.toContain("<article");
  });

  it("reads the current BOSS job-card-box field names", () => {
    const window = htmlWindow(`
      <li class="job-card-box">
        <div class="job-info">
          <a class="job-name" href="/job_detail/current123.html">当前 Go 工程师</a>
          <span class="job-salary">20-35K</span>
          <ul class="tag-list"><li>1-3年</li><li>本科</li></ul>
        </div>
        <div class="job-card-footer">
          <a class="boss-info"><span class="boss-name">当前科技</span></a>
          <span class="company-location">上海·徐汇区·龙华</span>
        </div>
      </li>
    `);

    expect(
      readCandidates(
        asBrowserDocument(window),
        "https://www.zhipin.com/web/geek/jobs?query=Go",
      ),
    ).toEqual([
      expect.objectContaining({
        id: "current123",
        title: "当前 Go 工程师",
        company: "当前科技",
        city: "上海",
        region: "徐汇区",
        salaryMinK: 20,
        salaryMaxK: 35,
      }),
    ]);
  });

  it("classifies login and verification pages before treating them as unsupported", () => {
    const login = htmlWindow("<main>手机号登录 扫码登录</main>");
    const verification = htmlWindow("<main>访问异常，请完成安全验证</main>");

    expect(
      inspectBossPage(
        asBrowserDocument(login),
        "https://www.zhipin.com/web/user/",
      ).kind,
    ).toBe("login");
    expect(
      inspectBossPage(
        asBrowserDocument(verification),
        "https://www.zhipin.com/web/geek/job",
      ).kind,
    ).toBe("verification");
  });

  it("reads the current contact state from the local detail fixture", () => {
    const window = fixtureWindow("job-detail.html");

    expect(readContactState(asBrowserDocument(window))).toBe("可沟通");
    window.document.querySelector("#contact")!.textContent = "继续沟通";
    expect(readContactState(asBrowserDocument(window))).toBe("平台已沟通");
  });

  it("用动作前基线确认新增的本人消息", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
        <section id="chat" hidden>
          <textarea id="message"></textarea>
          <button id="send">发送</button>
          <div class="message-list"><p class="item-myself">历史消息</p></div>
        </section>
      </main>
    `);
    const document = window.document;
    document.querySelector("#contact")!.addEventListener("click", () => {
      (document.querySelector("#chat") as unknown as HTMLElement).hidden =
        false;
    });
    document.querySelector("#send")!.addEventListener("click", () => {
      const item = document.createElement("p");
      item.className = "item-myself";
      item.textContent = (
        document.querySelector("#message") as unknown as HTMLTextAreaElement
      ).value;
      document.querySelector(".message-list")!.append(item);
    });

    await expect(
      sendOpeningFromDocument(
        asBrowserDocument(window),
        "您好，想进一步沟通。",
      ),
    ).resolves.toMatchObject({
      result: "沟通成功",
      confirmation: "matched-message",
      irreversibleStarted: true,
      baselineOutgoingCount: 1,
      finalOutgoingCount: 2,
    });
  });

  it("点击沟通后平台自动产生不同消息时不再追加模板", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
        <textarea id="message"></textarea>
        <button id="send">发送</button>
        <div class="message-list"></div>
      </main>
    `);
    const document = window.document;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const item = document.createElement("p");
      item.className = "item-myself";
      item.textContent = "平台默认招呼";
      document.querySelector(".message-list")!.append(item);
    });

    await expect(
      sendOpeningFromDocument(asBrowserDocument(window), "自定义开场模板"),
    ).resolves.toMatchObject({ result: "内容不符" });
    expect(document.querySelectorAll(".message-list > *")).toHaveLength(1);
  });

  it("把 BOSS 成功弹窗作为独立成功证据", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
      </main>
    `);
    const document = window.document;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const dialog = document.createElement("section");
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML = `
        <h2>已向BOSS发送消息</h2>
        <p>如需修改打招呼内容，请在【消息通知-设置招呼语】页面修改</p>
        <button>留在此页继续沟通</button>
      `;
      document.body.append(dialog);
    });

    await expect(
      sendOpeningFromDocument(
        asBrowserDocument(window),
        "您好，想进一步沟通。",
        100,
      ),
    ).resolves.toMatchObject({
      result: "沟通成功",
      confirmation: "boss-success-dialog",
      irreversibleStarted: true,
      finalOutgoingCount: 0,
    });
  });

  it("识别正文与继续沟通按钮分处同级容器的成功弹窗", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
      </main>
    `);
    const document = window.document;
    let stayedOnPage = false;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const layer = document.createElement("aside");
      layer.className = "boss-greeting-layer";
      layer.innerHTML = `
        <div class="dialog-content">
          <h2>已向BOSS发送消息</h2>
          <p>您好，我有信心能够胜任这个职位，希望能和您进一步沟通。</p>
          <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
        </div>
        <footer><button>留在此页继续沟通</button></footer>
      `;
      document.body.append(layer);
      layer.querySelector("button")!.addEventListener("click", () => {
        stayedOnPage = true;
      });
    });

    await expect(
      sendOpeningFromDocument(
        asBrowserDocument(window),
        "您好，我有信心能够胜任这个职位，希望能和您进一步沟通。",
        100,
      ),
    ).resolves.toMatchObject({
      result: "沟通成功",
      confirmation: "boss-success-dialog",
      irreversibleStarted: true,
    });
    expect(stayedOnPage).toBe(true);
  });

  it("双按钮成功弹窗进入聊天且不把开场模板写入职位搜索框", async () => {
    const window = htmlWindow(`
      <form class="job-search-form">
        <input id="search" type="text" value="Go" />
        <button>搜索</button>
      </form>
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
        <section id="chat" class="chat-panel" hidden>
          <textarea id="message"></textarea>
          <button id="send">发送</button>
          <div class="message-list"><p class="item-myself">平台默认招呼</p></div>
        </section>
      </main>
    `);
    const document = window.document;
    let stayedOnPage = false;
    let continued = false;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const layer = document.createElement("section");
      layer.className = "greet-expect-container";
      layer.innerHTML = `
        <div class="greet-expect-content">
          <h3>已向BOSS发送消息</h3>
          <p>您好，我有信心能够胜任这个职位，希望能和您进一步沟通。</p>
          <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
        </div>
        <div class="greet-expect-actions">
          <button id="stay">留在此页</button>
          <button id="continue">继续沟通</button>
        </div>
      `;
      document.body.append(layer);
      layer.querySelector("#stay")!.addEventListener("click", () => {
        stayedOnPage = true;
        layer.remove();
      });
      layer.querySelector("#continue")!.addEventListener("click", () => {
        continued = true;
        layer.remove();
        (document.querySelector("#chat") as unknown as HTMLElement).hidden =
          false;
      });
    });
    document.querySelector("#send")!.addEventListener("click", () => {
      const item = document.createElement("p");
      item.className = "item-myself";
      item.textContent = (
        document.querySelector("#message") as unknown as HTMLTextAreaElement
      ).value;
      document.querySelector(".message-list")!.append(item);
    });

    const outcome = await sendOpeningFromDocument(
      asBrowserDocument(window),
      "您好，我有信心能够胜任这个职位，希望能和您进一步沟通。",
      150,
    );

    expect({
      outcome,
      continued,
      stayedOnPage,
      searchValue: (
        document.querySelector("#search") as unknown as HTMLInputElement
      ).value,
    }).toMatchObject({
      outcome: {
        result: "沟通成功",
        confirmation: "matched-message",
        irreversibleStarted: true,
      },
      continued: true,
      stayedOnPage: false,
      searchValue: "Go",
    });
  });

  it("识别由非语义元素承载动作的 BOSS 成功回执", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
      </main>
    `);
    const document = window.document;
    let stayedOnPage = false;
    let continued = false;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const layer = document.createElement("section");
      layer.className = "greet-expect-container";
      layer.innerHTML = `
        <div class="greet-expect-content">
          <h3>已向BOSS发送消息</h3>
          <p>您好，我有信心能够胜任这个职位，希望能和您进一步沟通。</p>
          <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
        </div>
        <div class="greet-expect-actions">
          <div id="stay"><span>留在此页</span></div>
          <div id="continue"><span>继续沟通</span></div>
        </div>
      `;
      document.body.append(layer);
      layer.querySelector("#stay")!.addEventListener("click", () => {
        stayedOnPage = true;
      });
      layer.querySelector("#continue")!.addEventListener("click", () => {
        continued = true;
      });
    });

    const outcome = await sendOpeningFromDocument(
      asBrowserDocument(window),
      "您好，我有信心能够胜任这个职位，希望能和您进一步沟通。",
      100,
    );

    expect({ outcome, continued, stayedOnPage }).toMatchObject({
      outcome: {
        result: "沟通成功",
        confirmation: "boss-success-dialog",
        irreversibleStarted: true,
      },
      continued: true,
      stayedOnPage: false,
    });
  });

  it("成功回执成立后发送阶段抛错仍保持沟通成功", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
        <section id="chat" class="chat-panel" hidden>
          <textarea id="message"></textarea>
          <button id="send">发送</button>
        </section>
      </main>
    `);
    const document = window.document;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const dialog = document.createElement("section");
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML = `
        <h2>已向BOSS发送消息</h2>
        <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
        <button id="continue">继续沟通</button>
      `;
      document.body.append(dialog);
      dialog.querySelector("#continue")!.addEventListener("click", () => {
        dialog.remove();
        (document.querySelector("#chat") as unknown as HTMLElement).hidden =
          false;
      });
    });
    Object.defineProperty(document.querySelector("#send")!, "click", {
      value: () => {
        throw new Error("simulated send failure");
      },
    });

    await expect(
      sendOpeningFromDocument(
        asBrowserDocument(window),
        "您好，我有信心胜任这个职位。",
        100,
      ),
    ).resolves.toMatchObject({
      result: "沟通成功",
      confirmation: "boss-success-dialog",
      irreversibleStarted: true,
    });
  });

  it("没有继续沟通入口时仍尽力点击单独的留在此页动作", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
      </main>
    `);
    const document = window.document;
    let stayedOnPage = false;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const layer = document.createElement("section");
      layer.className = "greet-expect-container";
      layer.innerHTML = `
        <h2>已向BOSS发送消息</h2>
        <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
        <div id="stay"><span>留在此页</span></div>
      `;
      document.body.append(layer);
      layer.querySelector("#stay")!.addEventListener("click", () => {
        stayedOnPage = true;
      });
    });

    const outcome = await sendOpeningFromDocument(
      asBrowserDocument(window),
      "您好，我有信心胜任这个职位。",
      50,
    );

    expect({ outcome, stayedOnPage }).toMatchObject({
      outcome: {
        result: "沟通成功",
        confirmation: "boss-success-dialog",
      },
      stayedOnPage: true,
    });
  });

  it("非语义容器没有精确动作时不确认成功回执", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
      </main>
    `);
    const document = window.document;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const layer = document.createElement("section");
      layer.className = "greet-expect-container";
      layer.innerHTML = `
        <h2>已向BOSS发送消息</h2>
        <p>如需修改打招呼内容，请在【消息通知-设置打招呼语】页面修改</p>
      `;
      document.body.append(layer);
    });

    await expect(
      sendOpeningFromDocument(
        asBrowserDocument(window),
        "您好，我有信心胜任这个职位。",
        50,
      ),
    ).resolves.toMatchObject({ result: "结果未知" });
  });

  it("点击留在此页后自动发送当前开场模板", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
        <section id="chat" class="chat-panel" hidden>
          <textarea id="message"></textarea>
          <button id="send">发送</button>
          <div class="message-list"><p class="item-myself">平台默认招呼</p></div>
        </section>
      </main>
    `);
    const document = window.document;
    document.querySelector("#contact")!.addEventListener("click", () => {
      const dialog = document.createElement("section");
      dialog.id = "success-dialog";
      dialog.className = "boss-dialog";
      dialog.innerHTML = `
        <div class="dialog-content">
          <h2>已向BOSS发送消息</h2>
          <p>请在消息通知中设置招呼语</p>
        </div>
        <footer><button id="stay">留在此页继续沟通</button></footer>
      `;
      document.body.append(dialog);
      dialog.querySelector("#stay")!.addEventListener("click", () => {
        dialog.remove();
        (document.querySelector("#chat") as unknown as HTMLElement).hidden =
          false;
      });
    });
    document.querySelector("#send")!.addEventListener("click", () => {
      const item = document.createElement("p");
      item.className = "item-myself";
      item.textContent = (
        document.querySelector("#message") as unknown as HTMLTextAreaElement
      ).value;
      document.querySelector(".message-list")!.append(item);
    });

    await expect(
      sendOpeningFromDocument(
        asBrowserDocument(window),
        "您好，我有信心胜任这个职位。",
        500,
      ),
    ).resolves.toMatchObject({
      result: "沟通成功",
      confirmation: "matched-message",
      baselineOutgoingCount: 1,
      finalOutgoingCount: 2,
    });
    expect(
      (document.querySelector("#message") as unknown as HTMLTextAreaElement)
        .value,
    ).toBe("您好，我有信心胜任这个职位。");
  });

  it("不把页面正文中的相似文案误判为成功弹窗", async () => {
    const window = htmlWindow(`
      <main class="job-detail-box">
        <button id="contact">立即沟通</button>
        <article>
          <h2>已向BOSS发送消息</h2>
          <p>如需修改，请设置招呼语。</p>
          <p>留在此页继续沟通</p>
        </article>
      </main>
    `);

    await expect(
      sendOpeningFromDocument(asBrowserDocument(window), "开场模板", 50),
    ).resolves.toMatchObject({ result: "结果未知" });
  });

  it("在导航后的聊天文档中仅追加并确认开场模板", async () => {
    const window = htmlWindow(`
      <main class="chat-page">
        <section class="message-list">
          <p class="item-myself">平台默认招呼</p>
        </section>
        <textarea id="composer" placeholder="发送消息"></textarea>
        <button id="send">发送</button>
      </main>
    `);
    const { document } = window;
    document.querySelector("#send")!.addEventListener("click", () => {
      const item = document.createElement("p");
      item.className = "item-myself";
      item.textContent = (
        document.querySelector("#composer") as unknown as HTMLTextAreaElement
      ).value;
      document.querySelector(".message-list")!.append(item);
    });

    await expect(
      appendOpeningTemplateFromDocument(
        asBrowserDocument(window),
        "您好，想进一步沟通。",
        100,
      ),
    ).resolves.toEqual({ completed: true });
    expect(
      [...document.querySelectorAll(".item-myself")].map(
        (item) => item.textContent,
      ),
    ).toEqual(["平台默认招呼", "您好，想进一步沟通。"]);
  });

  it("跨文档续作不会把开场模板写入职位搜索框", async () => {
    const window = htmlWindow(`
      <main class="job-search-page">
        <form role="search">
          <input id="query" type="text" placeholder="搜索职位" />
          <button>搜索</button>
        </form>
      </main>
    `);
    const input = window.document.querySelector(
      "#query",
    ) as unknown as HTMLInputElement;

    await expect(
      appendOpeningTemplateFromDocument(
        asBrowserDocument(window),
        "不得写入搜索框",
        20,
      ),
    ).resolves.toEqual({ completed: false, error: "聊天输入框暂不可用" });
    expect(input.value).toBe("");
  });

  it("聊天页中的搜索联系人输入框不是聊天输入框", async () => {
    const window = htmlWindow(`
      <main class="chat-page">
        <header class="contact-list">
          <input id="contact-search" type="text" placeholder="搜索联系人" />
        </header>
      </main>
    `);
    const input = window.document.querySelector(
      "#contact-search",
    ) as unknown as HTMLInputElement;

    await expect(
      appendOpeningTemplateFromDocument(
        asBrowserDocument(window),
        "不得写入联系人搜索框",
        20,
      ),
    ).resolves.toEqual({ completed: false, error: "聊天输入框暂不可用" });
    expect(input.value).toBe("");
  });

  it("跨文档续作过期后不会再写入或发送模板", async () => {
    const window = htmlWindow(`
      <main class="chat-page">
        <textarea id="composer" placeholder="发送消息"></textarea>
        <button id="send">发送</button>
      </main>
    `);
    const composer = window.document.querySelector(
      "#composer",
    ) as unknown as HTMLTextAreaElement;
    const send = window.document.querySelector(
      "#send",
    ) as unknown as HTMLElement;
    let clicks = 0;
    send.addEventListener("click", () => {
      clicks += 1;
    });

    await expect(
      appendOpeningTemplateFromDocument(
        asBrowserDocument(window),
        "不得发送的过期模板",
        0,
      ),
    ).resolves.toEqual({ completed: false, error: "开场模板续作已经过期" });
    expect(composer.value).toBe("");
    expect(clicks).toBe(0);
  });
});

function fixtureWindow(name: string): Window {
  return htmlWindow(
    readFileSync(
      join(process.cwd(), "tests", "fixtures", "boss", name),
      "utf8",
    ),
  );
}

function htmlWindow(html: string): Window {
  const window = new Window({ url: "https://www.zhipin.com/" });
  window.document.write(html);
  return window;
}

function asBrowserDocument(window: Window): Document {
  return window.document as unknown as Document;
}
