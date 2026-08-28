import {
  inspectBossPage,
  readCandidates,
  readContactState,
  readCurrentCandidate,
  sendOpeningFromDocument,
} from "./boss-dom.ts";
import type { CandidatePosition } from "../core/rules.ts";

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  if (!isRequest(message)) return false;
  if (message.type === "inspect_page") {
    respond(inspectBossPage(document, location.href));
    return false;
  }
  if (message.type === "read_candidates") {
    const inspection = inspectBossPage(document, location.href);
    respond({
      inspection,
      candidates:
        inspection.kind === "list"
          ? readCandidates(document, location.href)
          : [],
    });
    return false;
  }
  if (message.type === "read_contact_state") {
    const inspection = inspectBossPage(document, location.href);
    respond({ inspection, contactState: readContactState(document) });
    return false;
  }
  if (message.type === "inspect_position") {
    const inspection = inspectBossPage(document, location.href);
    respond({
      inspection,
      candidate: readCurrentCandidate(
        document,
        location.href,
        message.candidate,
      ),
      contactState: readContactState(document),
    });
    return false;
  }
  if (message.type === "send_opening") {
    let responded = false;
    // “继续沟通” may replace this document and close the response channel.
    // A conclusive receipt must therefore be returned before that click.
    const respondOnce = (result: DomSendOpeningResult) => {
      if (responded) return;
      respond({
        inspection: inspectBossPage(document, location.href),
        ...result,
      });
      responded = true;
    };
    void sendOpeningFromDocument(
      document,
      message.message,
      undefined,
      respondOnce,
    ).then(respondOnce);
    return true;
  }
  return false;
});

notifyServiceWorker({
  type: "page_loaded",
  inspection: inspectBossPage(document, location.href),
  visible: document.visibilityState === "visible",
});

document.addEventListener("visibilitychange", () => {
  notifyServiceWorker({
    type: "page_visibility",
    visible: document.visibilityState === "visible",
    url: location.href,
  });
});

function notifyServiceWorker(message: unknown): void {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.runtime?.sendMessage !== "function"
  ) {
    return;
  }
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Reloading an unpacked extension invalidates already injected scripts.
  }
}

type ContentRequest =
  | { type: "inspect_page" | "read_candidates" | "read_contact_state" }
  | { type: "inspect_position"; candidate: CandidatePosition }
  | { type: "send_opening"; message: string };

type DomSendOpeningResult = Awaited<ReturnType<typeof sendOpeningFromDocument>>;

function isRequest(value: unknown): value is ContentRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    [
      "inspect_page",
      "read_candidates",
      "read_contact_state",
      "inspect_position",
      "send_opening",
    ].includes(String(value.type)) &&
    (String(value.type) !== "send_opening" ||
      ("message" in value && typeof value.message === "string")) &&
    (String(value.type) !== "inspect_position" || "candidate" in value)
  );
}
