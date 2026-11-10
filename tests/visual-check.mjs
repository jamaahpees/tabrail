import { mkdir } from "node:fs/promises";
import { configureExtension, connectClient, launchChrome, sleep, startBridge, startFixtureServer } from "./helpers.mjs";

const PORT = 8795;
const TOKEN = "visual-token-0123456789abcdef0123456789";
const OUT = "tests/.artifacts";

await mkdir(OUT, { recursive: true });
const fixture = await startFixtureServer();
const bridge = await startBridge({ port: PORT, token: TOKEN });
const { browser, extensionId } = await launchChrome();
await configureExtension(browser, extensionId, { port: PORT, token: TOKEN });
const client = await connectClient(PORT, TOKEN);
for (let index = 0; index < 40 && !client.ready?.extensionConnected; index += 1) await sleep(250);

const page = await browser.newPage();
await page.goto(fixture.url("/index.html"), { waitUntil: "load" });
await page.evaluate(() => {
  document.cookie = "demo_cookie=hello; path=/";
});
const tabs = await client.call("tabs", { action: "list" });
const tab = tabs.tabs.find((entry) => entry.url?.includes("/index.html"));
if (tab) {
  await client.call("snapshot", { tabId: tab.tabId });
  await client.call("get_text", { tabId: tab.tabId, selector: "#result" });
}

const popup = await browser.newPage();
await popup.setViewport({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
await sleep(2500);
await popup.screenshot({ path: `${OUT}/popup-dark.png` });

await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await sleep(300);
await popup.screenshot({ path: `${OUT}/popup-light.png` });

const options = await browser.newPage();
await options.setViewport({ width: 900, height: 900 });
await options.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
await sleep(800);
await options.screenshot({ path: `${OUT}/options-dark.png`, fullPage: true });

await options.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await sleep(300);
await options.screenshot({ path: `${OUT}/options-light.png`, fullPage: true });

const cookies = await browser.newPage();
await cookies.setViewport({ width: 900, height: 900 });
await cookies.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await cookies.goto(`chrome-extension://${extensionId}/cookies.html`, { waitUntil: "domcontentloaded" });
await cookies.evaluate(() => {
  document.querySelector("#enabled")?.click();
});
await sleep(400);
await cookies.evaluate(() => {
  const domain = document.querySelector("#domain");
  if (domain instanceof HTMLInputElement) domain.value = "127.0.0.1";
  document.querySelector("#read")?.click();
});
await sleep(600);
await cookies.screenshot({ path: `${OUT}/cookies-dark.png`, fullPage: true });

await cookies.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await sleep(300);
await cookies.screenshot({ path: `${OUT}/cookies-light.png`, fullPage: true });

await cookies.setViewport({ width: 420, height: 900 });
await sleep(200);
await cookies.screenshot({ path: `${OUT}/cookies-narrow.png`, fullPage: true });

await browser.close();
client.close();
bridge.stop();
await fixture.close();
console.log("screenshots written");
process.exit(0);
