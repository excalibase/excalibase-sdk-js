import { chromium } from "playwright";

const URL = "http://localhost:5175";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Count GraphQL whoami queries fired.
const whoamiQueries = [];
page.on("request", async r => {
  if (r.method() === "POST" && r.url().endsWith("/graphql")) {
    const post = r.postData() ?? "";
    if (post.includes("kanbanWhoamiView")) {
      whoamiQueries.push({ at: Date.now(), identity: post.slice(0, 80) });
      // Show headers for debug.
      console.log("    REQ headers:", JSON.stringify(r.headers()).slice(0, 250));
    }
  }
});

page.on("response", async r => {
  if (r.request().method() === "POST" && r.url().endsWith("/graphql")) {
    const post = r.request().postData() ?? "";
    if (post.includes("kanbanWhoamiView")) {
      const text = await r.text().catch(() => "(no body)");
      console.log("    RESP", r.status(), text.slice(0, 200));
    }
  }
});

page.on("console", m => {
  if (m.text().includes("[whoami]")) {
    console.log("    " + m.text().slice(0, 200));
  }
});

console.log("══ first load (cold cache) ══");
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
console.log(`  whoami queries: ${whoamiQueries.length}`);

async function switchTo(label) {
  await page.locator("header button").filter({ hasText: /Guest|Alice|Carol|Inventory admin|Admin/ }).last().click();
  await page.waitForTimeout(300);
  await page.getByRole("menuitem").filter({ hasText: new RegExp(label) }).click();
  await page.waitForTimeout(2000);
}

console.log("\n══ switch through all 4 identities (cold cache) ══");
const before = whoamiQueries.length;
await switchTo("Alice Chen");
await switchTo("Carol Park");
await switchTo("Admin");
await switchTo("Guest");
console.log(`  whoami queries fired during switches: ${whoamiQueries.length - before}`);

// Inspect localStorage after cold pass.
const stored = await page.evaluate(() => localStorage.getItem("excalibase.whoami.v1"));
console.log(`  localStorage cache: ${stored}`);

console.log("\n══ switch back through all 4 (warm cache) ══");
const before2 = whoamiQueries.length;
await switchTo("Alice Chen");
await switchTo("Carol Park");
await switchTo("Admin");
await switchTo("Guest");
console.log(`  whoami queries fired during switches: ${whoamiQueries.length - before2}`);

console.log("\n══ idle for 15s (was 60s refetch — should be 0) ══");
const before3 = whoamiQueries.length;
await page.waitForTimeout(15_000);
console.log(`  whoami queries during 15s idle: ${whoamiQueries.length - before3}`);

console.log("\n══ reload page (should hit localStorage, no fetch) ══");
const before4 = whoamiQueries.length;
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(2500);
console.log(`  whoami queries on cold reload: ${whoamiQueries.length - before4}`);

await browser.close();
