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
  const pointer = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", pointer));
  el.dispatchEvent(new PointerEvent("pointerenter", pointer));
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mouseenter", init));
  el.dispatchEvent(new PointerEvent("pointermove", pointer));
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

function cssPath(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement && parts.length < 6) {
    const current: Element = node;
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
    node = parent;
  }
  return parts.join(" > ");
}

function elementBox(params: Record<string, unknown>): unknown {
  const el = resolveTarget(params);
  if (params["scrollIntoView"] === true) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  }
  const rect = elementRect(el);
  return {
    element: describeElement(el),
    selector: cssPath(el),
    viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    page: { x: rect.x + rect.scrollX, y: rect.y + rect.scrollY, width: rect.width, height: rect.height },
    scroll: { x: rect.scrollX, y: rect.scrollY },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
  };
}

function elementsAtPoint(x: number, y: number): unknown {
  const stack = document.elementsFromPoint(x, y).slice(0, 4);
  return {
    cursor: { x, y },
    top: stack[0] ? { element: describeElement(stack[0]), selector: cssPath(stack[0]) } : null,
    stack: stack.map((el) => ({ element: describeElement(el), selector: cssPath(el) })),
  };
}

interface MutationSample {
  at: number;
  selector: string;
  element: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number } | null;
}

let pointerObserver: MutationObserver | null = null;
let pointerMutations: MutationSample[] = [];

function sampleNode(target: Node | null): MutationSample | null {
  if (!target) return null;
  const el = target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement;
  if (!el || el === document.body || el === document.documentElement) return null;

  const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return null;

  const rect = el.getBoundingClientRect();
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;

  return {
    at: Date.now(),
    selector: cssPath(el),
    element: describeElement(el),
    text: visible ? text : "",
    rect: visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
  };
}

function pointerStop(): unknown {
  pointerObserver?.disconnect();
  pointerObserver = null;
  return { watching: false };
}

function mutationStart(): unknown {
  pointerStop();
  pointerMutations = [];
  const root = document.body ?? document.documentElement;
  if (!root) throw new ActionError("no_document", "The page has no body element.");

  pointerObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (pointerMutations.length >= 60) break;
      const nodes: Node[] = record.type === "childList" ? Array.from(record.addedNodes) : [record.target];
      for (const node of nodes) {
        const sample = sampleNode(node);
        if (!sample) continue;
        if (pointerMutations.some((entry) => entry.selector === sample.selector)) continue;
        pointerMutations.push(sample);
      }
    }
  });
  pointerObserver.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  });
  return { watching: true, at: Date.now() };
}

function mutationRead(params: Record<string, unknown>): unknown {
  const x = num(params["x"]);
  const y = num(params["y"]);
  return {
    watching: pointerObserver !== null,
    changes: pointerMutations.slice(0, 30),
    ...(x !== undefined && y !== undefined ? { at_point: elementsAtPoint(x, y) } : {}),
  };
}

function elementsAt(params: Record<string, unknown>): unknown {
  const x = num(params["x"]);
  const y = num(params["y"]);
  if (x === undefined || y === undefined) {
    throw new ActionError("missing_point", "Pass x and y.", "Coordinates are viewport CSS pixels.");
  }
  return elementsAtPoint(x, y);
}

interface PickRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampTo(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function showPickedBadge(picked: {
  viewport: { x: number; y: number; width: number; height: number };
  page: { x: number; y: number; width: number; height: number };
  scroll: { x: number; y: number };
}): void {
  const existing = document.querySelector("[data-tabrail-hud]");
  if (existing) existing.remove();

  const hud = document.createElement("div");
  hud.dataset["tabrailHud"] = "1";
  hud.style.cssText = [
    "position:fixed",
    "bottom:18px",
    "right:18px",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "padding:8px 12px",
    "background:#1c1914",
    "color:#f2ede4",
    "border:1px solid #3b352b",
    "border-radius:8px",
    "box-shadow:0 4px 20px rgba(0,0,0,0.35)",
    "font:12px/1.4 system-ui,-apple-system,sans-serif",
    "pointer-events:auto",
  ].join(";");

  const text = document.createElement("span");
  text.textContent = `Area: ${picked.viewport.x},${picked.viewport.y} (${picked.viewport.width}×${picked.viewport.height})`;
  text.style.fontFamily = "ui-monospace,SF Mono,Consolas,monospace";
  text.style.fontWeight = "600";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy JSON";
  copyBtn.style.cssText = [
    "padding:3px 9px",
    "background:#e0a44a",
    "color:#191610",
    "border:none",
    "border-radius:4px",
    "font:inherit",
    "font-size:11px",
    "font-weight:600",
    "cursor:pointer",
  ].join(";");

  copyBtn.addEventListener("click", () => {
    const raw = JSON.stringify(picked, null, 2);
    void navigator.clipboard.writeText(raw).then(
      () => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy JSON";
        }, 1500);
      },
      () => {
        copyBtn.textContent = "Failed";
      },
    );
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕";
  closeBtn.title = "Dismiss";
  closeBtn.style.cssText = [
    "padding:2px 6px",
    "background:transparent",
    "color:#b3a999",
    "border:none",
    "font:inherit",
    "font-size:12px",
    "cursor:pointer",
  ].join(";");
  closeBtn.addEventListener("click", () => hud.remove());

  hud.append(text, copyBtn, closeBtn);
  (document.body ?? document.documentElement).append(hud);

  setTimeout(() => {
    if (hud.isConnected) hud.remove();
  }, 12_000);
}

function pickRegion(params: Record<string, unknown>): Promise<unknown> {
  const hasTarget = Boolean(str(params["ref"]) || str(params["selector"]));
  const target = hasTarget ? resolveTarget(params) : null;
  const targetRect = target ? elementRect(target) : null;
  const timeoutMs = Math.max(5_000, Math.min(300_000, num(params["timeoutMs"]) ?? 60_000));

  return new Promise((resolve, reject) => {
    const area: PickRect = targetRect
      ? { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height }
      : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };

    const overlay = document.createElement("div");
    overlay.dataset["tabrailPick"] = "1";
    overlay.style.cssText = [
      "position:fixed",
      `left:${area.x}px`,
      `top:${area.y}px`,
      `width:${Math.max(1, area.width)}px`,
      `height:${Math.max(1, area.height)}px`,
      "z-index:2147483647",
      "cursor:crosshair",
      "background:rgba(17,17,17,0.10)",
      "touch-action:none",
    ].join(";");

    const box = document.createElement("div");
    box.style.cssText =
      "position:absolute;border:1px dashed #fff;background:rgba(255,255,255,0.14);pointer-events:none;display:none;";

    const label = document.createElement("div");
    label.style.cssText =
      "position:absolute;padding:2px 6px;font:12px/1.4 system-ui,sans-serif;background:#111;color:#fff;pointer-events:none;white-space:nowrap;display:none;border-radius:3px;";

    overlay.append(box, label);

    let start: PickRect | null = null;
    let timer = 0;
    let settled = false;

    const cleanup = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };

    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const pointAt = (event: PointerEvent): PickRect => ({
      x: Math.round(clampTo(event.clientX, area.x, area.x + area.width)),
      y: Math.round(clampTo(event.clientY, area.y, area.y + area.height)),
      width: 0,
      height: 0,
    });

    const selectionAt = (event: PointerEvent): PickRect => {
      const point = pointAt(event);
      if (!start) return point;
      return {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      };
    };

    const paint = (rect: PickRect): void => {
      if (rect.width < 1 || rect.height < 1) {
        box.style.display = "none";
        label.style.display = "none";
        return;
      }
      box.style.display = "block";
      box.style.left = `${rect.x - area.x}px`;
      box.style.top = `${rect.y - area.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;

      label.style.display = "block";
      label.textContent = `${rect.x},${rect.y}  ${rect.width}x${rect.height}`;
      const above = rect.y - area.y - 22;
      label.style.left = `${rect.x - area.x}px`;
      label.style.top = `${above < 0 ? rect.y - area.y + rect.height + 4 : above}px`;
    };

    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish({ cancelled: true });
    }

    overlay.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      start = pointAt(event);
      overlay.setPointerCapture(event.pointerId);
      paint({ ...start, width: 0, height: 0 });
    });

    overlay.addEventListener("pointermove", (event) => {
      paint(selectionAt(event));
    });

    overlay.addEventListener("pointerup", (event) => {
      const rect = selectionAt(event);
      const viewport = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
      if (viewport.width < 2 || viewport.height < 2) {
        finish({ cancelled: true, note: "The drag was too small to count as a region." });
        return;
      }
      const result = {
        cancelled: false,
        viewport,
        page: {
          x: viewport.x + Math.round(window.scrollX),
          y: viewport.y + Math.round(window.scrollY),
          width: viewport.width,
          height: viewport.height,
        },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        viewportSize: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        element: target ? describeElement(target) : null,
      };
      showPickedBadge(result);
      void chrome.runtime.sendMessage({ type: "content:picked_region", region: result }).catch(() => undefined);
      finish(result);
    });

    window.addEventListener("keydown", onKey, true);
    (document.body ?? document.documentElement).append(overlay);

    timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ActionError(
          "pick_timeout",
          `No region was selected within ${Math.round(timeoutMs / 1000)}s.`,
          "Ask the person to drag a box over the page, or call browser_pick_region again.",
        ),
      );
    }, timeoutMs);
  });
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
  element_box: elementBox,
  elements_at: elementsAt,
  pick_region: pickRegion,
  mutation_start: mutationStart,
  mutation_read: mutationRead,
  mutation_stop: pointerStop,
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

  window.addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && (event.key === "P" || event.key === "p")) {
      event.preventDefault();
      if (!document.querySelector('[data-tabrail-pick="1"]')) {
        void pickRegion({ timeoutMs: 60000 });
      }
    }
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
