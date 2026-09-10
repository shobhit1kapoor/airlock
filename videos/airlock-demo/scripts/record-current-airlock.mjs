import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outputDirectory = fileURLToPath(new URL("../raw/", import.meta.url));
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  args: ["--force-color-profile=srgb"],
});

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outputDirectory, size: { width: 1920, height: 1080 } },
  colorScheme: "dark",
  reducedMotion: "no-preference",
});
const page = await context.newPage();
page.setDefaultTimeout(30000);

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);

await page.addStyleTag({
  content: `
    #airlock-recording-pointer {
      position: fixed;
      z-index: 2147483647;
      top: 0;
      left: 0;
      width: 28px;
      height: 38px;
      pointer-events: none;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, .55));
      will-change: transform;
    }
    #airlock-recording-pointer svg { display:block; width:100%; height:100%; }
    #airlock-recording-pointer .click-ring {
      opacity: 0;
      transform-origin: 10px 10px;
    }
    #airlock-recording-pointer.clicking .click-ring {
      animation: airlock-recording-click .26s ease-out;
    }
    @keyframes airlock-recording-click {
      0% { opacity:.58; transform:scale(.5); }
      100% { opacity:0; transform:scale(1.8); }
    }
  `,
});

await page.evaluate(() => {
  const pointer = document.createElement("div");
  pointer.id = "airlock-recording-pointer";
  pointer.innerHTML = `
    <svg viewBox="0 0 28 38" aria-hidden="true">
      <circle class="click-ring" cx="9" cy="9" r="7" fill="none" stroke="#dff8f6" stroke-width="1.5"/>
      <path d="M3 2 L3 30 L10 24 L14.5 35 L20 32.5 L15.4 22 L25 22 Z" fill="#f8fbfc" stroke="#15232b" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
  document.body.append(pointer);
  window.__airlockRecordingPointer = pointer;
});

let pointer = { x: 84, y: 100 };
const movePointer = async (target, duration = 720) => {
  const start = pointer;
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const curvature = Math.max(-34, Math.min(34, (dx * 0.075) - (dy * 0.035)));
  const control = { x: start.x + dx * 0.44 - curvature, y: start.y + dy * 0.42 + curvature };
  const steps = Math.max(6, Math.round(duration / 90));
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t * t * (3 - 2 * t);
    const inverse = 1 - eased;
    const x = inverse * inverse * start.x + 2 * inverse * eased * control.x + eased * eased * target.x;
    const y = inverse * inverse * start.y + 2 * inverse * eased * control.y + eased * eased * target.y;
    await page.evaluate(({ x: nextX, y: nextY }) => {
      window.__airlockRecordingPointer.style.transform = `translate3d(${Math.round(nextX)}px, ${Math.round(nextY)}px, 0)`;
    }, { x, y });
    await page.waitForTimeout(Math.round(duration / steps));
  }
  pointer = target;
};

const humanClick = async (locator, pause = 450) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Target was not visible for recording");
  const target = { x: box.x + Math.min(Math.max(20, box.width * 0.47), box.width - 12), y: box.y + Math.min(Math.max(16, box.height * 0.54), box.height - 10) };
  await movePointer(target, 660);
  await page.waitForTimeout(pause);
  await page.evaluate(() => {
    const element = window.__airlockRecordingPointer;
    element.classList.remove("clicking");
    void element.offsetWidth;
    element.classList.add("clicking");
  });
  await locator.click();
  await page.waitForTimeout(380);
};

const clickNav = async (name) => {
  await humanClick(page.getByRole("button", { name, exact: true }));
  await page.waitForTimeout(1350);
};
const closeSheet = async () => {
  const close = page.getByRole("button", { name: "Close details", exact: true });
  if (await close.isVisible().catch(() => false)) {
    await humanClick(close, 230);
    await page.waitForTimeout(900);
  }
};
const runScenario = async (title) => {
  const row = page.locator(".scenario-row").filter({ hasText: title });
  await humanClick(row.getByRole("button", { name: "Run test", exact: true }));
  await page.getByText("Test completed", { exact: true }).waitFor({ state: "visible", timeout: 45000 });
  await page.waitForTimeout(3700);
};

// The actual current frontend is what is recorded below. Pointer positions only
// make the real interactions readable to a viewer; the browser handles every UI action.
await page.waitForTimeout(2700);
await clickNav("Agent graph");
await page.waitForTimeout(3200);

await clickNav("Attack lab");
await page.waitForTimeout(1800);
await runScenario("Destructive MCP denial");
await closeSheet();
await runScenario("A2A destination denial");
await closeSheet();

const approvalRow = page.locator(".scenario-row").filter({ hasText: "Approval-gated branch" });
await humanClick(approvalRow.getByRole("button", { name: "Run test", exact: true }));
await page.getByText("APPROVAL REQUEST", { exact: true }).waitFor({ state: "visible", timeout: 45000 });
await page.waitForTimeout(2600);
await humanClick(page.getByRole("button", { name: "Approve once", exact: true }));
await page.getByText("Grant consumed after successful branch creation.", { exact: true }).waitFor({ state: "visible", timeout: 45000 });
await page.waitForTimeout(3200);
await closeSheet();

await clickNav("Models");
await page.waitForTimeout(2200);
await humanClick(page.getByRole("button", { name: "Force primary failure", exact: true }));
await page.getByText("Test completed", { exact: true }).waitFor({ state: "visible", timeout: 45000 });
await page.waitForTimeout(3500);
await closeSheet();

await clickNav("Traffic & audit");
await page.waitForTimeout(2100);
const evidence = page.getByRole("button", { name: /Native Kong telemetry received/ }).first();
await humanClick(evidence);
await page.getByText("TRACE INSPECTOR", { exact: true }).waitFor({ state: "visible", timeout: 30000 });
await page.waitForTimeout(4300);

const video = await page.video();
await context.close();
await browser.close();
console.log(await video.path());
