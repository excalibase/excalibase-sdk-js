import { chromium } from "playwright";

const URL = "http://localhost:5175";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const reqs = [];
page.on("request", r => reqs.push({ method: r.method(), url: r.url(), at: Date.now() }));
page.on("response", r => {
  const idx = reqs.findIndex(x => x.url === r.url() && x.method === r.request().method());
  if (idx >= 0) reqs[idx].status = r.status();
});
page.on("requestfailed", r => {
  const idx = reqs.findIndex(x => x.url === r.url() && x.method === r.method());
  if (idx >= 0) reqs[idx].failed = r.failure()?.errorText ?? "unknown";
});
page.on("console", m => {
  if (m.text().includes("comment") || m.type() === "error") {
    console.log(`  [${m.type()}] ${m.text().slice(0, 400)}`);
  }
});
page.on("pageerror", e => console.log(`  [pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// Switch to Admin (most permissive)
await page.getByRole("button", { name: /Guest|Alice|Carol|Inventory admin|Admin/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole("menuitem", { name: /Admin/ }).click();
await page.waitForTimeout(2000);

// Click first card
await page.locator(".cursor-pointer").first().click();
await page.waitForTimeout(800);

// Clear req buffer to focus on the comment action
const beforeCount = reqs.length;

// Type a comment + click Post
const ta = page.locator('textarea[placeholder*="Comment as"]');
console.log(`textarea count: ${await ta.count()}`);
if (await ta.count()) {
  await ta.fill("playwright comment test");
  const postBtn = page.getByRole("button", { name: /Post/ });
  console.log(`Post button count: ${await postBtn.count()}`);
  await postBtn.click();
  await page.waitForTimeout(2500);
}

console.log("\n═══ network calls during comment-Post ═══");
const newReqs = reqs.slice(beforeCount);
const interesting = newReqs.filter(r => r.url.includes("/api/v1") || r.url.includes("/graphql") || r.method !== "GET");
interesting.forEach(r => {
  console.log(`  ${r.method.padEnd(6)} ${r.url}  → ${r.status ?? r.failed ?? "(pending)"}`);
});

// Check what error UI rendered
const errorText = await page.locator('text=REST request').first().textContent().catch(() => null);
if (errorText) {
  console.log(`\n  UI error: "${errorText}"`);
}

await browser.close();
