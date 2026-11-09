import type { ContentRequest, ContentResponse, ToolErrorPayload } from "./protocol.js";
import {
  describeElement,
  elementRect,
  resetRefs,
  resolveRef,
  takeSnapshot,
  type SnapshotMode,
} from "./snapshot.js";

class ActionError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    this.hint = hint;
  }
}

function payloadOf(error: unknown): ToolErrorPayload {
  if (error instanceof ActionError) {
    return { code: error.code, message: error.message, hint: error.hint };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "action_failed", message };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveTarget(params: Record<string, unknown>): Element {
  const ref = str(params["ref"]);
  if (ref) {
    const el = resolveRef(ref);
    if (!el) {
      throw new ActionError(
        "stale_ref",
        `The element reference "${ref}" is no longer valid on this page.`,
        "Call browser_snapshot again and use the fresh ref.",
      );
    }
    if (!el.isConnected) {
      throw new ActionError("stale_ref", `The element for "${ref}" is detached from the DOM.`, "Take a new snapshot.");
    }
    return el;
  }

  const selector = str(params["selector"]);
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) throw new ActionError("element_not_found", `No element matches the selector "${selector}".`);
    return el;
  }

  throw new ActionError("missing_target", "Pass either ref or selector.", "Take a snapshot first, then use its ref.");
}

function centerOf(el: Element): { x: number; y: number } {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const rect = elementRect(el);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function mouseInit(button: string, clickCount: number): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: button === "right" ? 2 : button === "middle" ? 1 : 0,
    buttons: 1,
    detail: clickCount,
  };
}

function click(params: Record<string, unknown>): unknown {
  const el = resolveTarget(params);
  const button = str(params["button"]) ?? "left";
  const clickCount = num(params["clickCount"]) ?? 1;

  const disabled =
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    el.closest("fieldset[disabled]") !== null;
  if (disabled) {
    return { clicked: false, element: describeElement(el), reason: "disabled" };
  }

  const point = centerOf(el);

  if (params["trusted"] === true) {
    return { trusted: true, x: point.x, y: point.y, button, clickCount, element: describeElement(el) };
  }

  (el as HTMLElement).focus?.({ preventScroll: true });
  const init = mouseInit(button, clickCount);
  const pointer = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", pointer));
  el.dispatchEvent(new PointerEvent("pointerenter", pointer));
  el.dispatchEvent(new PointerEvent("pointerdown", pointer));
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new PointerEvent("pointerup", pointer));
  el.dispatchEvent(new MouseEvent("mouseup", init));
  el.dispatchEvent(new MouseEvent("click", init));

  return { clicked: describeElement(el), button, clickCount };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
}

function type(params: Record<string, unknown>): unknown {
  const el = resolveTarget(params);
  const text = typeof params["text"] === "string" ? params["text"] : "";
  const clear = params["clear"] !== false;

  (el as HTMLElement).focus?.({ preventScroll: true });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.readOnly || el.disabled) throw new ActionError("not_editable", `${describeElement(el)} is read only.`);
    if (clear) {
      setNativeValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setNativeValue(el, el.value + text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    if (clear) el.textContent = "";
    el.focus();
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  } else {
    throw new ActionError(
      "not_editable",
      `${describeElement(el)} is not an input, textarea, or contenteditable element.`,
    );
  }

  if (params["submit"] === true) {
    const form = el.closest("form");
    if (form) form.requestSubmit();
    else dispatchKey(el, "Enter");
  }

  return { typed: text.length, element: describeElement(el), submitted: params["submit"] === true };
}

interface ParsedKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function parseKey(raw: string): ParsedKey {
  const parts = raw.split("+").filter(Boolean);
  const key = parts.pop() ?? raw;
  const has = (name: RegExp): boolean => parts.some((part) => name.test(part));
  return {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: has(/^(ctrl|control)$/i),
    altKey: has(/^alt$/i),
    shiftKey: has(/^shift$/i),
    metaKey: has(/^(meta|cmd|command)$/i),
  };
}

function dispatchKey(el: Element, raw: string): void {
  const parsed = parseKey(raw);
  const init: KeyboardEventInit = {
    key: parsed.key,
    code: parsed.code,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: parsed.ctrlKey,
    altKey: parsed.altKey,
    shiftKey: parsed.shiftKey,
    metaKey: parsed.metaKey,
  };
  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
}

function pressKey(params: Record<string, unknown>): unknown {
  const raw = str(params["key"]);
  if (!raw) throw new ActionError("missing_key", "Pass a key such as Enter or Control+A.");
  const el = str(params["ref"]) || str(params["selector"]) ? resolveTarget(params) : document.activeElement ?? document.body;
  dispatchKey(el, raw);
  return { pressed: raw, element: describeElement(el) };
}

function hover(params: Record<string, unknown>): unknown {
  const el = resolveTarget(params);
  const rect = elementRect(el);
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
  };
  el.dispatchEvent(new PointerEvent("pointerover", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mouseenter", init));
  el.dispatchEvent(new MouseEvent("mousemove", init));
  return { hovered: describeElement(el) };
}

function selectOption(params: Record<string, unknown>): unknown {
  const el = resolveTarget(params);
  if (!(el instanceof HTMLSelectElement)) {
    throw new ActionError("not_a_select", `${describeElement(el)} is not a select element.`, "Use browser_click on custom dropdowns instead.");
  }
  const values = Array.isArray(params["values"]) ? params["values"].map((value) => String(value)) : [];
  if (values.length === 0) throw new ActionError("missing_values", "Pass at least one value to select.");

  const matched: string[] = [];
  for (const option of Array.from(el.options)) {
    const label = option.textContent?.trim() ?? "";
    const hit = values.some((value) => value === option.value || value === label);
    if (!hit) continue;
    option.selected = true;
    matched.push(option.value);
  }

  if (matched.length === 0) {
    throw new ActionError(
      "option_not_found",
      `None of ${JSON.stringify(values)} exist in this select.`,
      `Available options: ${Array.from(el.options).map((option) => option.value).join(", ")}`,
    );
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: matched };
}

function scroll(params: Record<string, unknown>): unknown {
  const direction = str(params["direction"]) ?? "down";
  const amount = num(params["amount"]) ?? Math.round(window.innerHeight * 0.9);
  const dx = direction === "right" ? amount : direction === "left" ? -amount : 0;
  const dy = direction === "down" ? amount : direction === "up" ? -amount : 0;

  const target = str(params["ref"]) || str(params["selector"]) ? resolveTarget(params) : null;
  if (target) {
    target.scrollBy({ top: dy, left: dx, behavior: "instant" as ScrollBehavior });
  } else {
    window.scrollBy({ top: dy, left: dx, behavior: "instant" as ScrollBehavior });
  }

  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    direction,
    amount,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(params: Record<string, unknown>): Promise<unknown> {
  const selector = str(params["selector"]);
  const text = str(params["text"]);
  const urlIncludes = str(params["urlIncludes"]);
  if (!selector && !text && !urlIncludes) {
    throw new ActionError("missing_condition", "Pass selector, text, or urlIncludes.");
  }

  const timeout = num(params["timeoutMs"]) ?? 15_000;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (selector && document.querySelector(selector)) {
      return { matched: "selector", value: selector, waitedMs: Date.now() - started };
    }
    if (text && (document.body?.innerText ?? "").includes(text)) {
      return { matched: "text", value: text, waitedMs: Date.now() - started };
    }
    if (urlIncludes && location.href.includes(urlIncludes)) {
      return { matched: "url", value: urlIncludes, waitedMs: Date.now() - started };
    }
    await sleep(120);
  }

  throw new ActionError(
    "wait_timeout",
    `Nothing matched within ${timeout}ms.`,
    "Take a snapshot to see the current page state before waiting again.",
  );
}

function getText(params: Record<string, unknown>): unknown {
  const wantsTarget = Boolean(str(params["ref"]) || str(params["selector"]));
  const el = wantsTarget ? resolveTarget(params) : document.body;
  if (!el) throw new ActionError("no_document", "The page has no body element.");
  const raw = el instanceof HTMLElement ? el.innerText : el.textContent ?? "";
  const text = raw.replace(/\n{3,}/g, "\n\n").trim();
  return {
    element: wantsTarget ? describeElement(el) : "body",
    length: text.length,
    text: text.slice(0, 20_000),
    truncated: text.length > 20_000,
  };
}

function snapshot(params: Record<string, unknown>): unknown {
  const mode = (str(params["mode"]) as SnapshotMode | undefined) ?? "full";
  return takeSnapshot({ mode, maxNodes: num(params["maxNodes"]) });
}

function elementBounds(params: Record<string, unknown>): unknown {
  const el = resolveTarget(params);
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  return { ...elementRect(el), element: describeElement(el) };
}

const handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>> = {
  snapshot,
  click,
  type,
  press_key: pressKey,
  hover,
  select_option: selectOption,
  scroll,
  wait_for: waitFor,
  get_text: getText,
  element_rect: elementBounds,
};

function init(): void {
  resetRefs();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (type === "content:ping") {
      sendResponse({ ok: true, ready: true });
      return undefined;
    }
    if (type !== "content:req") return undefined;

    const request = message as Partial<ContentRequest>;
    const method = request.method ?? "";
    const handler = handlers[method];
    if (!handler) {
      sendResponse({ ok: false, error: { code: "unknown_method", message: `Unknown content method ${method}` } } satisfies ContentResponse);
      return undefined;
    }

    void (async () => {
      try {
        const result = await handler(request.params ?? {});
        sendResponse({ ok: true, result } satisfies ContentResponse);
      } catch (error) {
        sendResponse({ ok: false, error: payloadOf(error) } satisfies ContentResponse);
      }
    })();
    return true;
  });
}

declare global {
  interface Window {
    __remoteBrowserContentReady?: boolean;
  }
}

if (!window.__remoteBrowserContentReady) {
  window.__remoteBrowserContentReady = true;
  init();
}
