export type SnapshotMode = "full" | "interactive" | "diff";

export interface SnapshotOptions {
  mode?: SnapshotMode;
  maxNodes?: number;
}

export interface SnapshotResult {
  text: string;
  url: string;
  title: string;
  nodeCount: number;
  truncated: boolean;
  mode: SnapshotMode;
}

interface RefEntry {
  el: Element;
  path: string;
  tag: string;
  signature: string;
}

interface NodeInfo {
  el: Element;
  role: string;
  name: string;
  value: string;
  states: string[];
  interactive: boolean;
  depth: number;
}

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "HEAD",
  "META",
  "LINK",
  "TITLE",
  "BR",
  "SOURCE",
  "TRACK",
  "PARAM",
]);

const TEXT_BLOCK_TAGS = new Set([
  "P",
  "PRE",
  "CODE",
  "BLOCKQUOTE",
  "DD",
  "DT",
  "TD",
  "TH",
  "FIGCAPTION",
  "LEGEND",
  "OPTGROUP",
  "ADDRESS",
  "CAPTION",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "tab",
  "menuitem",
  "switch",
  "slider",
  "spinbutton",
  "file",
]);

const refs = new Map<string, RefEntry>();
const elementToRef = new WeakMap<Element, string>();
let refCounter = 0;
let previousSnapshot: Map<string, string> | null = null;

export function resetRefs(): void {
  refs.clear();
  refCounter = 0;
  previousSnapshot = null;
}

function buildPath(el: Element): string {
  const indices: number[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    indices.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return indices.join("/");
}

function findByPath(path: string): Element | null {
  if (!path) return document.documentElement;
  let current: Element = document.documentElement;
  for (const part of path.split("/")) {
    const index = Number(part);
    if (!Number.isInteger(index)) return null;
    const child: Element | undefined = current.children[index];
    if (!child) return null;
    current = child;
  }
  return current;
}

function signatureOf(el: Element): string {
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  return [el.tagName, el.id, el.getAttribute("name") ?? "", el.getAttribute("placeholder") ?? "", text].join("|");
}

function refFor(el: Element): string {
  const existing = elementToRef.get(el);
  if (existing) {
    const entry = refs.get(existing);
    if (entry) {
      entry.path = buildPath(el);
      entry.tag = el.tagName;
    }
    return existing;
  }
  const ref = `e${++refCounter}`;
  refs.set(ref, { el, path: buildPath(el), tag: el.tagName, signature: signatureOf(el) });
  elementToRef.set(el, ref);
  return ref;
}

export function resolveRef(ref: string): Element | null {
  const entry = refs.get(ref);
  if (!entry) return null;
  if (entry.el.isConnected) return entry.el;
  const recovered = findByPath(entry.path);
  if (recovered && recovered.tagName === entry.tag && signatureOf(recovered) === entry.signature) {
    entry.el = recovered;
    return recovered;
  }
  return null;
}

export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  return text ? `${tag}${id} "${text}"` : `${tag}${id}`;
}

function isSkipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if ((el as HTMLElement).hidden) return true;
  return false;
}

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (style.opacity === "0" && el.childElementCount === 0) return false;
  return true;
}

function directText(el: Element): string {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue ?? "";
  }
  return text.replace(/\s+/g, " ").trim();
}

function labelledByText(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function accessibleName(el: Element): string {
  const labelled = labelledByText(el);
  if (labelled) return labelled.slice(0, 120);

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim().slice(0, 120);

  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const labels = Array.from(el.labels ?? [])
      .map((label) => label.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (labels) return labels.slice(0, 120);
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
      if (el.value) return el.value.slice(0, 120);
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim().slice(0, 120);
  }

  if (el instanceof HTMLImageElement && el.alt) return el.alt.slice(0, 120);

  const title = el.getAttribute("title");
  if (title) return title.trim().slice(0, 120);

  if (el.childElementCount === 0 || TEXT_BLOCK_TAGS.has(el.tagName)) {
    return directText(el).slice(0, 120);
  }

  return "";
}

function statesOf(el: Element): string[] {
  const states: string[] = [];
  const ariaChecked = el.getAttribute("aria-checked");
  if (ariaChecked) states.push(`checked=${ariaChecked}`);
  else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    states.push(`checked=${el.checked}`);
  }
  if (el.getAttribute("aria-selected") === "true") states.push("selected");
  if (el.getAttribute("aria-expanded")) states.push(`expanded=${el.getAttribute("aria-expanded")}`);
  if (el.getAttribute("aria-pressed")) states.push(`pressed=${el.getAttribute("aria-pressed")}`);
  if (el.getAttribute("aria-disabled") === "true") states.push("disabled");
  else if ((el as HTMLButtonElement).disabled === true) states.push("disabled");
  if (el.getAttribute("aria-required") === "true" || (el as HTMLInputElement).required === true) states.push("required");
  if (el.getAttribute("aria-readonly") === "true" || (el as HTMLInputElement).readOnly === true) states.push("readonly");
  if (el.getAttribute("aria-invalid") === "true") states.push("invalid");
  if (el instanceof HTMLAnchorElement && el.href) states.push(`href=${el.getAttribute("href") ?? ""}`.slice(0, 90));
  return states;
}

function valueOf(el: Element): string {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return el.value ? "••••••" : "";
    if (el.type === "checkbox" || el.type === "radio") return "";
    return el.value.slice(0, 120);
  }
  if (el instanceof HTMLTextAreaElement) return el.value.slice(0, 120);
  if (el instanceof HTMLSelectElement) {
    const selected = Array.from(el.selectedOptions)
      .map((option) => option.textContent?.trim() ?? option.value)
      .join(", ");
    return selected.slice(0, 120);
  }
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText.slice(0, 120);
  return "";
}

interface RoleInfo {
  role: string;
  interactive: boolean;
  level?: number;
}

function roleOf(el: Element): RoleInfo | null {
  const explicit = el.getAttribute("role");
  if (explicit) {
    const primary = explicit.split(/\s+/)[0] ?? explicit;
    return { role: primary, interactive: INTERACTIVE_ROLES.has(primary) };
  }

  if (el instanceof HTMLAnchorElement) {
    return el.hasAttribute("href") ? { role: "link", interactive: true } : { role: "generic", interactive: false };
  }
  if (el instanceof HTMLButtonElement) return { role: "button", interactive: true };
  if (el instanceof HTMLSelectElement) {
    return el.multiple || el.size > 1
      ? { role: "listbox", interactive: true }
      : { role: "combobox", interactive: true };
  }
  if (el instanceof HTMLTextAreaElement) return { role: "textbox", interactive: true };
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case "checkbox":
        return { role: "checkbox", interactive: true };
      case "radio":
        return { role: "radio", interactive: true };
      case "range":
        return { role: "slider", interactive: true };
      case "number":
        return { role: "spinbutton", interactive: true };
      case "search":
        return { role: "searchbox", interactive: true };
      case "submit":
      case "button":
      case "reset":
      case "image":
        return { role: "button", interactive: true };
      case "file":
        return { role: "file", interactive: true };
      case "hidden":
        return null;
      default:
        return { role: "textbox", interactive: true };
    }
  }
  if (el instanceof HTMLOptionElement) return { role: "option", interactive: true };
  if (el instanceof HTMLImageElement) return { role: "img", interactive: false };
  if (el instanceof HTMLElement && el.isContentEditable) return { role: "textbox", interactive: true };

  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    return { role: "heading", interactive: false, level: Number(tag.slice(1)) };
  }
  const mapped: Record<string, string> = {
    UL: "list",
    OL: "list",
    LI: "listitem",
    TABLE: "table",
    TR: "row",
    TD: "cell",
    TH: "cell",
    FORM: "form",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    ASIDE: "complementary",
    DIALOG: "dialog",
    SUMMARY: "button",
    FIELDSET: "group",
    FIGURE: "figure",
    SVG: "graphics-document",
    IFRAME: "iframe",
    VIDEO: "video",
    AUDIO: "audio",
    CANVAS: "canvas",
  };
  const role = mapped[tag];
  if (role) {
    return { role, interactive: role === "button" };
  }
  return null;
}

function shouldEmitText(el: Element, role: RoleInfo | null): boolean {
  if (role?.interactive) return false;
  if (role && !["generic", "listitem", "cell", "figure"].includes(role.role)) return false;
  if (el.childElementCount > 0 && !TEXT_BLOCK_TAGS.has(el.tagName)) return false;
  return directText(el).length > 0;
}

function formatNode(info: NodeInfo, withRef: boolean): string {
  const parts: string[] = [`- ${info.role}`];
  if (info.name) parts.push(JSON.stringify(info.name));
  if (info.value) parts.push(`value=${JSON.stringify(info.value)}`);
  const states = info.states.filter((state) => !state.startsWith("href="));
  if (states.length) parts.push(`[${states.join(", ")}]`);
  if (withRef) parts.push(`ref=${refFor(info.el)}`);
  return parts.join(" ");
}

function nodeKey(path: string, info: NodeInfo): string {
  return `${path}|${info.role}|${info.name}|${info.value}|${info.states.join(",")}`;
}

export function takeSnapshot(options: SnapshotOptions = {}): SnapshotResult {
  const mode: SnapshotMode = options.mode ?? "full";
  const maxNodes = options.maxNodes ?? 800;

  for (const [ref, entry] of refs) {
    if (entry.el.isConnected) continue;
    const recovered = findByPath(entry.path);
    if (!recovered || recovered.tagName !== entry.tag) refs.delete(ref);
  }

  const lines: string[] = [];
  const currentMap = new Map<string, string>();
  const counters = { nodes: 0, truncated: false };

  const walk = (el: Element, depth: number): void => {
    if (counters.truncated) return;
    if (isSkipped(el) || !isVisible(el)) return;

    const role = roleOf(el);
    const isInteractive = role?.interactive === true;

    if (role && (!mode.startsWith("interactive") || isInteractive)) {
      if (counters.nodes >= maxNodes) {
        counters.truncated = true;
        return;
      }
      counters.nodes += 1;

      const info: NodeInfo = {
        el,
        role: role.role,
        name: accessibleName(el),
        value: valueOf(el),
        states: role.level ? [`level=${role.level}`, ...statesOf(el)] : statesOf(el),
        interactive: isInteractive,
        depth,
      };

      const formatted = formatNode(info, true);
      const indent = "  ".repeat(Math.min(depth, 10));
      const line = `${indent}${formatted}`;
      lines.push(line);
      currentMap.set(buildPath(el), formatted);
    } else if (mode === "full" && shouldEmitText(el, role)) {
      if (counters.nodes >= maxNodes) {
        counters.truncated = true;
        return;
      }
      counters.nodes += 1;
      const text = directText(el).slice(0, 160);
      const indent = "  ".repeat(Math.min(depth, 10));
      const ref = `ref=${refFor(el)}`;
      const formatted = `- text ${JSON.stringify(text)} ${ref}`;
      lines.push(`${indent}${formatted}`);
      currentMap.set(buildPath(el), formatted);
    }

    if (el.tagName === "IFRAME") return;
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) {
      for (const child of Array.from(shadow.children)) walk(child, depth + 1);
    }
    for (const child of Array.from(el.children)) {
      walk(child, mode === "interactive" ? 0 : depth + 1);
    }
  };

  if (document.body) walk(document.body, 0);

  const header = [`[page] ${location.href}`, `[title] ${document.title}`];
  let text: string;

  if (mode === "diff" && previousSnapshot) {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [path, line] of currentMap) {
      const before = previousSnapshot.get(path);
      if (!before) added.push(`+ ${line}`);
      else if (before !== line) changed.push(`~ ${line}`);
    }
    for (const [path, line] of previousSnapshot) {
      if (!currentMap.has(path)) removed.push(`- ${line}`);
    }
    text = [
      ...header,
      `[diff] +${added.length} -${removed.length} ~${changed.length}`,
      ...added,
      ...removed,
      ...changed,
      ...(added.length + removed.length + changed.length === 0 ? ["(no changes)"] : []),
    ].join("\n");
  } else {
    text = [...header, ...lines].join("\n");
  }

  previousSnapshot = currentMap;

  if (counters.truncated) {
    text += `\n[note] Truncated at ${maxNodes} nodes. Scroll, narrow the scope with interactive mode, or use browser_get_text.`;
  }

  return {
    text,
    url: location.href,
    title: document.title,
    nodeCount: counters.nodes,
    truncated: counters.truncated,
    mode,
  };
}

export function elementRect(el: Element): { x: number; y: number; width: number; height: number; scrollX: number; scrollY: number } {
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}
