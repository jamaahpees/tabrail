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

function refFor(snapshot, pattern) {
  const match = snapshot.match(new RegExp(`${pattern}[^\\n]*ref=(e\\d+)`));
  assert.ok(match, `No ref found for ${pattern}\n${snapshot}`);
  return match[1];
}

function isPng(base64) {
  const buffer = Buffer.from(base64, "base64");
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

test("drives a real Chrome tab through the bridge", async (t) => {
  const fixture = await startFixtureServer();
  const bridge = await startBridge({ port: PORT, token: TOKEN });
  const { browser, extensionId } = await launchChrome();

  t.after(async () => {
    await browser.close().catch(() => undefined);
    bridge.stop();
    await fixture.close();
  });

  await configureExtension(browser, extensionId, { port: PORT, token: TOKEN });
  const client = await connectClient(PORT, TOKEN);
  t.after(() => client.close());

  await waitUntil(() => client.ready?.extensionConnected, 25_000, "extension connection");

  const status = await client.call("status");
  assert.equal(status.bridge.state, "connected");
  assert.equal(status.extensionVersion, "0.1.0");

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
  await popup.waitForFunction(
    () => document.querySelector("#status-text")?.textContent === "Connected",
    { timeout: 10_000 },
  );
  const pillState = await popup.$eval("#status-pill", (element) => element.dataset.state);
  assert.equal(pillState, "connected");
});
