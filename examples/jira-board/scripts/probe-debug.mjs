import { chromium } from "playwright";

const URL = "http://localhost:5175";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const allConsole = [];
page.on("console", m => allConsole.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", e => allConsole.push(`[pageerror] ${e.message}`));

const reqs = [];
page.on("request", r => reqs.push({ method: r.method(), url: r.url(), at: Date.now() }));
page.on("response", r => {
  const idx = reqs.findIndex(x => x.url === r.url() && x.method === r.request().method() && !x.status);
  if (idx >= 0) reqs[idx].status = r.status();
});
page.on("requestfailed", r => {
  const idx = reqs.findIndex(x => x.url === r.url() && x.method === r.method() && !x.status && !x.failed);
  if (idx >= 0) reqs[idx].failed = r.failure()?.errorText ?? "unknown";
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// Switch to Admin via the topbar identity dropdown.
const trigger = page.locator("header button").filter({ hasText: /Guest|Alice|Carol/ }).last();
console.log(`trigger count: ${await trigger.count()}`);
await trigger.click();
await page.waitForTimeout(500);
const adminItem = page.getByRole("menuitem").filter({ hasText: /Admin/ });
console.log(`menuitem count: ${await adminItem.count()}`);
await adminItem.click();
// Wait specifically for the projects to load (sidebar has "Mobile App" only when admin/auth).
await page.waitForSelector("text=Mobile App", { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1500);

// Click an issue card by title.
const card = page.locator('h3:has-text("REST filter operators")').first();
console.log(`card count: ${await card.count()}`);
if (await card.count() === 0) {
  // Maybe board not loaded — try any card
  const anyCard = page.locator(".bg-white.rounded-md.shadow-card").first();
  console.log(`fallback card count: ${await anyCard.count()}`);
  if (await anyCard.count()) {
    await anyCard.click();
  }
} else {
  await card.click();
}
await page.waitForTimeout(1500);

// Verify drawer opened
const drawerTitle = await page.locator('h2.text-xl').first().textContent().catch(() => null);
console.log(`drawer title: ${drawerTitle ?? "(no drawer)"}`);

// Try to type in textarea
const ta = page.locator('textarea').first();
console.log(`textarea count: ${await ta.count()}`);
const beforeReqs = reqs.length;

if (await ta.count()) {
  await ta.fill("debug from playwright");
  await page.waitForTimeout(200);
  const post = page.getByRole("button", { name: /Post/ }).first();
  console.log(`Post button enabled: ${!(await post.isDisabled())}`);
  await post.click();
  await page.waitForTimeout(3500);
}

console.log("\n═══ console messages during Post ═══");
allConsole.filter(s => s.includes("comment") || s.includes("sdk") || s.includes("error") || s.includes("FAIL")).forEach(s => console.log("  " + s.slice(0, 250)));

console.log("\n═══ network calls (since Post click) ═══");
const newReqs = reqs.slice(beforeReqs);
newReqs.filter(r => !r.url.includes("hot-update") && !r.url.includes(".tsx") && !r.url.includes("_pings_"))
  .forEach(r => console.log(`  ${r.method.padEnd(6)} ${r.url.replace("http://localhost:5175", "")} → ${r.status ?? r.failed ?? "(?)"}`));

await page.screenshot({ path: "/tmp/probe-debug.png", clip: { x: 0, y: 0, width: 1440, height: 900 } });
await browser.close();
