import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const URL = "http://localhost:5175";
const SHOTS = "/home/duc/Documents/duk/excalibase-sdk-js/examples/jira-board/screenshots";
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
const networkPatches = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("console.error: " + m.text().slice(0, 200)); });
page.on("request", r => {
  if (r.method() === "PATCH" || r.method() === "POST") {
    networkPatches.push(`${r.method()} ${r.url()}`);
  }
});
page.on("response", r => {
  if (r.request().method() === "PATCH" || r.request().method() === "POST") {
    const idx = networkPatches.findIndex(p => p.endsWith(r.url()));
    if (idx >= 0) networkPatches[idx] += ` → ${r.status()}`;
  }
});

console.log(`→ ${URL}`);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// Switch to Admin (most permissive — can drag any card).
await page.getByRole("button", { name: /Guest|Alice|Carol|Inventory admin|Admin/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole("menuitem", { name: /Admin/ }).click();
await page.waitForTimeout(2000);

await page.screenshot({ path: `${SHOTS}/06-fixed-admin-board.png`, clip: { x: 0, y: 0, width: 1440, height: 900 } });
console.log("  · 06-fixed-admin-board.png (after status-case fix)");

// Count cards per column header.
const cols = ["BACKLOG", "TO DO", "IN PROGRESS", "IN REVIEW", "DONE"];
for (const name of cols) {
  const header = page.locator(`h2:has-text("${name}")`).first();
  if (await header.count()) {
    // Count siblings = card count badge text.
    const badge = await header.locator("xpath=following-sibling::span[1]").textContent().catch(() => "?");
    console.log(`  ${name.padEnd(12)} → ${badge?.trim()} cards`);
  }
}

// Drag the first card from Backlog to In Progress.
const firstCard = page.locator(".divide-y").first().locator("..");  // not ideal, use direct selector
const backlogColumn = page.locator('h2:has-text("BACKLOG")').first().locator("xpath=ancestor::div[contains(@class,'flex-shrink-0')]");
const inProgressColumn = page.locator('h2:has-text("IN PROGRESS")').first().locator("xpath=ancestor::div[contains(@class,'flex-shrink-0')]");

const card = backlogColumn.locator(".cursor-pointer").first();
if (await card.count()) {
  const cardBox = await card.boundingBox();
  const targetBox = await inProgressColumn.boundingBox();
  if (cardBox && targetBox) {
    console.log(`\nDragging from (${Math.round(cardBox.x)}, ${Math.round(cardBox.y)}) to (${Math.round(targetBox.x + targetBox.width/2)}, ${Math.round(targetBox.y + 100)})…`);
    await page.mouse.move(cardBox.x + cardBox.width/2, cardBox.y + cardBox.height/2);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width/2 + 50, cardBox.y + 50, { steps: 10 });
    await page.mouse.move(targetBox.x + targetBox.width/2, targetBox.y + 200, { steps: 30 });
    await page.mouse.up();
    await page.waitForTimeout(2500);
    console.log(`  network calls: ${networkPatches.length}`);
    networkPatches.forEach(p => console.log("    " + p));
  }
}

await page.screenshot({ path: `${SHOTS}/07-after-drag.png`, clip: { x: 0, y: 0, width: 1440, height: 900 } });
console.log("  · 07-after-drag.png");

console.log(`\nerrors: ${errors.length}`);
errors.slice(0, 5).forEach(e => console.log("  ✗ " + e));

await browser.close();
process.exit(errors.length ? 1 : 0);
