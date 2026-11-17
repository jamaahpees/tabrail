import test from "node:test";
import assert from "node:assert/strict";
import {
  configureExtension,
  connectClient,
  launchChrome,
  sleep,
  startBridge,
  startFixtureServer,
  waitUntil,
} from "./helpers.mjs";

const PORT = 8791;
const TOKEN = "e2e-token-0123456789abcdef0123456789";
const WRONG_TOKEN = "e2e-wrong-token-0123456789abcdef";

function refFor(snapshot, pattern) {
  const match = snapshot.match(new RegExp(`${pattern}[^\\n]*ref=(e\\d+)`));
  assert.ok(match, `No ref found for ${pattern}\n${snapshot}`);
  return match[1];
}

function isPng(base64) {
  const buffer = Buffer.from(base64, "base64");
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

async function clickInPage(page, selector) {
  const clicked = await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) return false;
    element.click();
    return true;
  }, selector);
  assert.ok(clicked, `selector ${selector} was not found`);
}

async function setField(page, selector, value) {
  const ok = await page.evaluate(
    ({ target, next }) => {
      const element = document.querySelector(target);
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
      element.value = next;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    { target: selector, next: value },
  );
  assert.ok(ok, `field ${selector} was not found`);
}

test("drives a real Chrome tab through the bridge", async (t) => {
  const fixture = await startFixtureServer();
  const bridge = await startBridge({
    port: PORT,
    token: TOKEN,
    extraEnv: { MCP_BROWSER_ALLOW_LOCAL_PAIRING: "1" },
  });
  const { browser, extensionId } = await launchChrome();

  t.after(async () => {
    await browser.close().catch(() => undefined);
    bridge.stop();
    await fixture.close();
  });

  const optionsPage = await configureExtension(browser, extensionId, { port: PORT, token: WRONG_TOKEN });
  const client = await connectClient(PORT, TOKEN);
  t.after(() => client.close());

  // A stale token must recover through local pairing instead of retrying forever.
  await waitUntil(() => client.ready?.extensionConnected, 25_000, "extension connection after token recovery");

  await clickInPage(optionsPage, "#reveal");
  assert.equal(await optionsPage.$eval("#token", (element) => element.type), "text");
  await clickInPage(optionsPage, "#reveal");
  assert.equal(await optionsPage.$eval("#token", (element) => element.type), "password");

  await waitUntil(() => client.ready?.extensionConnected, 25_000, "extension connection");

  const status = await client.call("status");
  assert.equal(status.bridge.state, "connected");
  assert.equal(status.extensionVersion, "0.5.0");
  await waitUntil(async () => (await client.call("status")).role?.active === true, 8000, "active browser role");

  const page = await browser.newPage();
  await page.goto(fixture.url("/index.html"), { waitUntil: "load" });
  await page.bringToFront();

  const listed = await client.call("tabs", { action: "list" });
  const tab = listed.tabs.find((entry) => entry.url?.includes("/index.html"));
  assert.ok(tab, "fixture tab is listed");
  const tabId = tab.tabId;

  const navigated = await client.call("navigate", { url: fixture.url("/index.html"), tabId });
  assert.equal(navigated.tabId, tabId);
  assert.match(navigated.url, /index\.html$/);

  const snapshot = await client.call("snapshot", { tabId });
  assert.match(snapshot.text, /heading "Checkout fixture" \[level=1\]/);
  assert.match(snapshot.text, /textbox "Email"/);
  assert.match(snapshot.text, /button "Apply code" \[disabled\]/);
  assert.match(snapshot.text, /combobox "Carrier"/);

  const emailRef = refFor(snapshot.text, '- textbox "Email"');
  const applyRef = refFor(snapshot.text, '- button "Apply code"');

  await client.call("type", { tabId, ref: emailRef, text: "buyer@example.com" });
  assert.equal(await page.$eval("#email", (element) => element.value), "buyer@example.com");

  await client.call("click", { tabId, ref: applyRef });
  assert.equal(await page.$eval("#result", (element) => element.textContent), "No code applied.");

  const enableRef = refFor(snapshot.text, '- button "Enable apply"');
  await client.call("click", { tabId, ref: enableRef });

  const promoRef = refFor(snapshot.text, '- textbox "Promo code"');
  await client.call("type", { tabId, ref: promoRef, text: "SAVE10" });
  await client.call("click", { tabId, ref: applyRef });
  assert.equal(await page.$eval("#result", (element) => element.textContent), "Code applied: 10% off.");

  const carrierRef = refFor(snapshot.text, '- combobox "Carrier"');
  await client.call("select_option", { tabId, ref: carrierRef, values: ["sicepat"] });
  assert.equal(await page.$eval("#carrier", (element) => element.value), "sicepat");

  await client.call("click", { tabId, selector: "#submit" });
  assert.equal(
    await page.$eval("#result", (element) => element.textContent),
    "Order placed for buyer@example.com",
  );

  const elementShot = await client.call("screenshot", { tabId, ref: emailRef });
  assert.ok(isPng(elementShot.data), "element screenshot is a PNG");

  const fullShot = await client.call("screenshot", { tabId, fullPage: true });
  assert.ok(isPng(fullShot.data), "full page screenshot is a PNG");

  const box = await client.call("get_box", { tabId, selector: "#chart", scrollIntoView: true });
  assert.ok(box.viewport.width >= 400, "chart box reports a width");
  assert.ok(box.viewportSize.width > 0, "chart box reports the viewport size");
  assert.equal(Math.round(box.page.x - box.viewport.x), Math.round(box.scroll.x), "page and viewport x agree");
  assert.equal(Math.round(box.page.y - box.viewport.y), Math.round(box.scroll.y), "page and viewport y agree");

  const pageMove = await client.call("mouse_move", {
    tabId,
    x: box.page.x + 60,
    y: box.page.y + 40,
    space: "page",
  });
  assert.ok(
    Math.abs(pageMove.x - Math.round(box.viewport.x + 60)) <= 1,
    `page coordinates convert to viewport, got ${pageMove.x}`,
  );

  const elementMove = await client.call("mouse_move", { tabId, selector: "#chart", offsetX: 20, offsetY: 20 });
  const settled = await client.call("get_box", { tabId, selector: "#chart" });
  assert.equal(
    elementMove.x,
    Math.round(settled.viewport.x + settled.viewport.width / 2 + 20),
    "element offset move targets the element centre",
  );

  const point = { x: Math.round(settled.viewport.x + 140), y: Math.round(settled.viewport.y + 90) };
  const cell = { x: point.x - Math.round(settled.viewport.x), y: point.y - Math.round(settled.viewport.y) };
  const moved = await client.call("mouse_move", { tabId, x: point.x, y: point.y, steps: 3 });
  assert.deepEqual({ x: moved.x, y: moved.y }, point, "move reports the point it landed on");

  const readCell = async (selector) => {
    const text = (await client.call("get_text", { tabId, selector })).text;
    const match = text.match(/(-?\d+),(-?\d+)/);
    assert.ok(match, `expected a coordinate pair in ${selector}, got ${text}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };

  await waitUntil(
    async () => Math.abs((await readCell("#move-readout")).x - cell.x) <= 1,
    5000,
    "move readout matches the pointer",
  );

  const tooltipText = await client.call("get_text", { tabId, selector: "#tooltip" });
  assert.match(tooltipText.text, /^cell \d+,\d+$/, "canvas tooltip is readable as DOM text");

  await client.call("mouse_click", { tabId, x: point.x, y: point.y });
  await waitUntil(
    async () => Math.abs((await readCell("#click-readout")).x - cell.x) <= 1,
    5000,
    "click readout matches the pointer",
  );

  const dragEnd = { x: point.x + 120, y: point.y };
  const dragged = await client.call("mouse_drag", { tabId, from: point, to: dragEnd, steps: 6 });
  assert.deepEqual(dragged.from, point);
  assert.deepEqual(dragged.to, dragEnd);
  await waitUntil(
    async () => Math.abs((await readCell("#drop-readout")).x - (cell.x + 120)) <= 1,
    5000,
    "drag released at the end point",
  );

  const probeBox = await client.call("get_box", { tabId, selector: "#chart", scrollIntoView: true });
  const probePoint = { x: Math.round(probeBox.viewport.x + 200), y: Math.round(probeBox.viewport.y + 120) };
  const probe = await client.call("pointer_probe", { tabId, x: probePoint.x, y: probePoint.y, waitMs: 250 });
  assert.ok(probe.changes.length > 0, "probe reports DOM changes around the pointer");
  assert.ok(
    probe.changes.some((entry) => entry.selector === "#tooltip" || /cell \d+,\d+/.test(entry.text)),
    "probe finds the tooltip that the pointer opened",
  );
  assert.match(probe.at_point.top.element, /canvas/, "probe reports the element under the pointer");

  const regionShot = await client.call("screenshot", {
    tabId,
    selector: "#chart",
    region: { x: 0, y: 0, width: 100, height: 60 },
  });
  assert.ok(isPng(regionShot.data), "region screenshot is a PNG");
  assert.equal(regionShot.css.width, 100, "region screenshot keeps the requested width");
  assert.equal(regionShot.css.height, 60, "region screenshot keeps the requested height");

  const pickFrom = { x: Math.round(probeBox.viewport.x + 40), y: Math.round(probeBox.viewport.y + 40) };
  const pickCall = client.call("pick_region", { tabId, capture: true, timeoutMs: 20_000 });
  await sleep(600);
  await page.mouse.move(pickFrom.x, pickFrom.y);
  await page.mouse.down();
  await page.mouse.move(pickFrom.x + 140, pickFrom.y + 100, { steps: 6 });
  await page.mouse.up();
  const picked = await pickCall;
  assert.equal(picked.cancelled, false, "pick returned a region");
  assert.ok(Math.abs(picked.viewport.width - 140) <= 2, `picked width ${picked.viewport.width}`);
  assert.ok(Math.abs(picked.viewport.height - 100) <= 2, `picked height ${picked.viewport.height}`);
  assert.equal(Math.round(picked.page.x - picked.viewport.x), Math.round(picked.scroll.x), "picked page x agrees");
  assert.ok(isPng(picked.screenshot.data), "picked region captured as a PNG");
  assert.equal(picked.screenshot.css.width, picked.viewport.width, "picked screenshot matches the region");

  const hud = await page.$("[data-tabrail-hud]");
  assert.ok(hud, "on-page HUD badge appeared after picking");
  assert.match(await page.$eval("[data-tabrail-hud]", (el) => el.textContent), /Area: \d+,\d+/, "HUD shows area coords");

  const cancelCall = client.call("pick_region", { tabId, timeoutMs: 20_000 });
  await sleep(600);
  await page.keyboard.press("Escape");
  const cancelled = await cancelCall;
  assert.equal(cancelled.cancelled, true, "Escape cancels the pick");

  const scrollerBox = await client.call("get_box", { tabId, selector: "#scroller", scrollIntoView: true });
  const wheelPoint = {
    x: Math.round(scrollerBox.viewport.x + scrollerBox.viewport.width / 2),
    y: Math.round(scrollerBox.viewport.y + scrollerBox.viewport.height / 2),
  };
  await client.call("mouse_wheel", { tabId, x: wheelPoint.x, y: wheelPoint.y, deltaY: 240 });
  await waitUntil(
    async () => Number((await client.call("get_text", { tabId, selector: "#wheel-readout" })).text) > 0,
    5000,
    "wheel scrolled the panel",
  );

  const rangeBox = await client.call("get_box", { tabId, selector: "#range", scrollIntoView: true });
  const rangeStart = {
    x: Math.round(rangeBox.viewport.x + rangeBox.viewport.width / 2),
    y: Math.round(rangeBox.viewport.y + rangeBox.viewport.height / 2),
  };
  const rangeEnd = { x: Math.round(rangeBox.viewport.x + rangeBox.viewport.width - 6), y: rangeStart.y };
  await client.call("mouse_drag", { tabId, from: rangeStart, to: rangeEnd, steps: 8 });
  await waitUntil(
    async () => Number(await page.$eval("#range", (element) => element.value)) > 50,
    5000,
    "drag moved the range slider",
  );

  await assert.rejects(
    () => client.call("mouse_move", { tabId, x: -40, y: 20 }),
    (error) => {
      assert.equal(error.code, "point_out_of_viewport");
      return true;
    },
  );

  const text = await client.call("get_text", { tabId, selector: "#result" });
  assert.match(text.text, /Order placed/);

  const firstConsole = await client.call("console", { tabId });
  if (firstConsole.entries.length === 0) {
    assert.match(firstConsole.note, /capture started/i);
  } else {
    assert.ok(firstConsole.entries.some((entry) => entry.text.includes("fixture loaded")));
  }

  await page.reload({ waitUntil: "load" });
  const consoleAfter = await waitUntil(
    async () => {
      const result = await client.call("console", { tabId });
      return result.entries.length > 0 ? result : null;
    },
    10_000,
    "console entries",
  );
  assert.ok(consoleAfter.entries.some((entry) => entry.text.includes("fixture loaded")));

  const network = await waitUntil(
    async () => {
      const result = await client.call("network", { tabId });
      return result.entries.length > 0 ? result : null;
    },
    10_000,
    "network entries",
  );
  assert.ok(network.entries.some((entry) => entry.url.includes("/index.html")));

  const clickPromise = client.call("click", { tabId, selector: "#alert" }, 20_000).catch((error) => error);
  await sleep(600);
  const withDialog = await waitUntil(
    async () => {
      const current = await client.call("status", { tabId });
      return current.pendingDialogs.length > 0 ? current : null;
    },
    8000,
    "pending dialog",
  );
  assert.equal(withDialog.pendingDialogs[0].type, "confirm");

  await client.call("handle_dialog", { tabId, accept: true });
  await clickPromise;
  await waitUntil(
    async () => (await page.$eval("#result", (element) => element.textContent)) === "Confirmed.",
    5000,
    "dialog result",
  );

  await client.call("navigate", { url: fixture.url("/spa.html"), tabId });
  const spaSnapshot = await client.call("snapshot", { tabId });
  const oldButtonRef = refFor(spaSnapshot.text, '- button "Select product 1 round 1"');
  await client.call("click", { tabId, selector: "#rerender" });

  await assert.rejects(
    () => client.call("click", { tabId, ref: oldButtonRef }),
    (error) => {
      assert.equal(error.code, "stale_ref");
      return true;
    },
  );

  const fresh = await client.call("snapshot", { tabId, mode: "interactive" });
  assert.match(fresh.text, /Select product 1 round 2/);
  assert.doesNotMatch(fresh.text, /heading "SPA fixture"/);

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
  await popup.waitForSelector("#token");
  await setField(popup, "#token", TOKEN);
  await clickInPage(popup, "#save");
  await popup.waitForFunction(
    () => /Token saved/.test(document.querySelector("#save-feedback")?.textContent ?? ""),
    { timeout: 10_000 },
  );
  await popup.waitForFunction(
    () => document.querySelector("#status-text")?.textContent === "Connected",
    { timeout: 15_000 },
  );

  const secondPage = await browser.newPage();
  await secondPage.goto(fixture.url("/index.html"), { waitUntil: "load" });

  const tabsNow = await client.call("tabs", { action: "list" });
  const spaTab = tabsNow.tabs.find((entry) => entry.url?.includes("/spa.html"));
  const checkoutTab = tabsNow.tabs.find((entry) => entry.url?.includes("/index.html"));
  assert.ok(spaTab, "spa tab is listed");
  assert.ok(checkoutTab, "checkout tab is listed");

  await clickInPage(popup, `[data-tab-id="${spaTab.tabId}"]`);
  await waitUntil(
    async () => (await client.call("status")).pinnedTabId === spaTab.tabId,
    8000,
    "pinned tab saved",
  );
  const pinnedSnapshot = await client.call("snapshot", {});
  assert.match(pinnedSnapshot.text, /SPA fixture/);

  await clickInPage(popup, '[data-tab-id="auto"]');
  await secondPage.bringToFront();
  await waitUntil(
    async () => (await client.call("status")).pinnedTabId === null,
    8000,
    "pin cleared",
  );
  await waitUntil(
    async () => {
      const snapshot = await client.call("snapshot", {});
      return /Checkout fixture/.test(snapshot.text) ? snapshot : null;
    },
    8000,
    "active tab follows focus",
  );

  await popup.bringToFront();
  await popup.waitForSelector("#pick-result:not([hidden])", { timeout: 8000 });
  const coordsText = await popup.$eval("#pick-coords", (el) => el.textContent);
  assert.match(coordsText, /\d+, \d+ \(\d+×\d+\)/, "popup displays the picked area coordinates");
  await clickInPage(popup, "#clear-pick");
  await popup.waitForSelector("#pick-result[hidden]", { timeout: 5000 });

  await secondPage.bringToFront();
  await secondPage.evaluate(() => {
    document.cookie = "e2e_cookie=hello; path=/";
  });

  const cookiePage = await browser.newPage();
  await cookiePage.goto(`chrome-extension://${extensionId}/cookies.html?domain=127.0.0.1&autoread=1`, {
    waitUntil: "domcontentloaded",
  });
  await cookiePage.waitForFunction(() => document.body.textContent?.includes("e2e_cookie"), {
    timeout: 10_000,
    polling: 100,
  });
  assert.equal(await cookiePage.$eval("#enabled", (element) => element.checked), true);

  const importEntry = [
    {
      name: "e2e_import",
      value: "yes",
      domain: "127.0.0.1",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "lax",
      session: true,
      hostOnly: true,
    },
  ];
  await setField(cookiePage, "#import-json", JSON.stringify(importEntry));
  await clickInPage(cookiePage, "#import");
  await cookiePage.waitForFunction(
    () => /Imported/.test(document.querySelector("#feedback")?.textContent ?? ""),
    { timeout: 10_000, polling: 100 },
  );
  const cookieString = await secondPage.evaluate(() => document.cookie);
  assert.match(cookieString, /e2e_import=yes/);

  await clickInPage(cookiePage, "#clear");
  await clickInPage(cookiePage, "#clear");
  await cookiePage.waitForFunction(
    () => /Removed/.test(document.querySelector("#summary")?.textContent ?? ""),
    { timeout: 10_000, polling: 100 },
  );
  const cookiesAfter = await secondPage.evaluate(() => document.cookie);
  assert.doesNotMatch(cookiesAfter, /e2e_import/);

  await popup.bringToFront();
  await clickInPage(popup, "#enabled");
  await popup.waitForFunction(
    () => document.querySelector("#status-text")?.textContent === "Paused",
    { timeout: 10_000, polling: 100 },
  );
  await clickInPage(popup, "#enabled");
  await popup.waitForFunction(
    () => document.querySelector("#status-text")?.textContent === "Connected",
    { timeout: 15_000, polling: 100 },
  );

  await clickInPage(popup, "#reconnect");
  await popup.waitForFunction(
    () => document.querySelector("#status-text")?.textContent === "Connected",
    { timeout: 15_000, polling: 100 },
  );

  const pillState = await popup.$eval("#status-pill", (element) => element.dataset.state);
  assert.equal(pillState, "connected");
  await popup.waitForFunction(
    () => document.querySelector("#browser-role-text")?.textContent === "In use",
    { timeout: 10_000, polling: 100 },
  );

  await clickInPage(optionsPage, "#test");
  await optionsPage.waitForFunction(
    () => /Bridge connected/.test(document.querySelector("#feedback")?.textContent ?? ""),
    { timeout: 15_000, polling: 100 },
  );
});







