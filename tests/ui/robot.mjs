// Browser robot: opens the real page in Chromium and presses the buttons a
// person would, on a phone-sized and a desktop-sized screen.
//   node tests/ui/robot.mjs            → against the local stub server
//   node tests/ui/robot.mjs --public https://cloudaicore.com
//                                      → signed-out checks on the live site
import { startStubServer } from "./stub-server.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const publicIndex = process.argv.indexOf("--public");
const publicOrigin = publicIndex > 0 ? process.argv[publicIndex + 1] : "";
const results = [];
let failed = 0;

async function step(name, run) {
  try {
    await run();
    results.push(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    const reason = String(error.message).split("\n")[0].slice(0, 200);
    results.push(`❌ ${name} — ${reason}`);
    // Shows up as an annotation on the GitHub check.
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=UI robot::${name} — ${reason}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

process.on("unhandledRejection", (error) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=UI robot crashed::${String(error?.message || error).split("\n")[0].slice(0, 300)}`);
  console.error(error);
  process.exit(1);
});

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--no-sandbox"],
});

async function openPage(origin, viewport, path = "/") {
  const page = await browser.newPage({ viewport, locale: "bg-BG" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(origin + path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  return { page, errors };
}

async function signedInFlows(origin, requests, label, viewport) {
  const { page, errors } = await openPage(origin, viewport);
  const last = () => page.locator(".assistant-turn").last();
  const send = async (text) => {
    await page.fill("#chatInput", text);
    await page.click("#sendBtn");
  };

  await step(`${label}: страницата зарежда без грешки`, async () => {
    expect(await page.locator("#chatInput").isVisible(), "няма поле за писане");
    expect(await page.locator("#sendBtn").isVisible(), "бутонът за изпращане е извън екрана");
    expect(!errors.length, errors[0]);
  });
  await step(`${label}: избор на модел`, async () => {
    await page.click("#modelPickerBtn");
    await page.locator("#modelPickerMenu button", { hasText: "Gemini 3.5 Flash Lite" }).click();
    expect((await page.textContent("#modelPickerLabel")).includes("Gemini"), "етикетът не се смени");
    expect(await page.locator("#modelPickerMenu button", { hasText: "Grok" }).isDisabled(), "несвързан модел може да се избере");
  });
  await step(`${label}: съобщение и отговор от избрания модел`, async () => {
    await send("Здравей");
    await page.waitForTimeout(900);
    expect((await last().innerText()).includes("gemini-2.5-flash-lite"), "отговорът не е от избрания модел");
    expect(requests.at(-1).model === "gemini-2.5-flash-lite", "моделът не е изпратен");
  });
  await step(`${label}: „Пробвай с друг модел“`, async () => {
    await last().locator('[data-action="retry-model"]').click();
    await page.locator(".retry-model-menu button", { hasText: "Claude Haiku 5.5" }).click();
    await page.waitForTimeout(900);
    expect(requests.at(-1).rewrite === true, "липсва rewrite");
    expect(requests.at(-1).model === "claude-haiku-4-5-20251001", "друг модел не е изпратен");
    expect((await page.locator(".user-turn").count()) === 1, "старият въпрос остана два пъти");
  });
  await step(`${label}: редакция на изпратено съобщение`, async () => {
    await page.locator(".user-turn").first().locator('[data-action="edit"]').click();
    await page.fill(".message-edit textarea", "Здравей, редактирано");
    await page.click(".message-edit-buttons .primary");
    await page.waitForTimeout(900);
    expect(requests.at(-1).message === "Здравей, редактирано", "редакцията не е изпратена");
    expect((requests.at(-1).recentHistory || []).length === 0, "старата история не е изчистена");
  });
  await step(`${label}: бутон „Спри“`, async () => {
    await send("бавно моля");
    await page.waitForTimeout(900);
    expect((await page.locator("#sendBtn i").getAttribute("class")).includes("fa-stop"), "няма бутон Спри");
    await page.click("#sendBtn");
    await page.waitForTimeout(400);
    expect((await page.locator("#sendBtn i").getAttribute("class")).includes("fa-arrow-up"), "бутонът не се върна");
    expect(!(await page.locator("#chatInput").isDisabled()), "полето остана заключено");
  });
  await step(`${label}: асистент и подсказка с „/“`, async () => {
    await page.click("#attachBtn");
    await page.click('[data-plus="assistant"]');
    await page.locator(".assistant-picker button", { hasText: "Юрист" }).click();
    expect(await page.locator(".assistant-chip").isVisible(), "няма надпис за асистента");
    await page.type("#chatInput", "/об");
    await page.waitForTimeout(200);
    expect(await page.locator(".slash-menu").isVisible(), "няма меню с подсказки");
    await page.keyboard.press("Enter");
    expect((await page.inputValue("#chatInput")).length > 5, "подсказката не попълни полето");
    await page.type("#chatInput", "договор");
    await page.click("#sendBtn");
    await page.waitForTimeout(900);
    expect(requests.at(-1).assistant === "lawyer", "асистентът не е изпратен");
  });
  await step(`${label}: Съвет в колони`, async () => {
    await page.click("#attachBtn");
    await page.click('[data-plus="council"]');
    await send("Въпрос за Съвета");
    await page.waitForTimeout(900);
    expect(requests.at(-1).council === true, "Съветът не е включен в заявката");
    expect((await page.locator(".council-card").count()) === 2, "няма две колони");
  });
  await step(`${label}: „Сподели разговора“`, async () => {
    await page.click("#chatOptions summary");
    await page.click("#conversationShareBtn");
    await page.click(".share-create");
    await page.waitForTimeout(400);
    expect((await page.inputValue(".share-link input")).includes("/s/"), "няма линк");
    await page.click(".share-close");
  });
  await step(`${label}: без грешки в страницата накрая`, async () => expect(!errors.length, errors[0]));
  await page.close();
}

async function sharedPage(origin) {
  const { page, errors } = await openPage(origin, { width: 390, height: 844 }, "/s/AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  await step("Споделен разговор: страницата показва съобщенията", async () => {
    expect((await page.locator(".shared-message").count()) === 2, "няма две съобщения");
    expect(!errors.length, errors[0]);
  });
  await page.close();
}

async function publicChecks(origin) {
  const { page, errors } = await openPage(origin, { width: 390, height: 844 });
  await step("Жив сайт: екранът за вход зарежда без грешки", async () => {
    await page.waitForTimeout(1500);
    expect(await page.locator("#authScreen, .auth-screen, form").first().isVisible(), "няма екран за вход");
    expect(!errors.length, errors[0]);
  });
  await step("Жив сайт: има бутон „Вход с Google“", async () => {
    expect(await page.locator(".auth-google").first().isVisible(), "бутонът липсва");
  });
  await page.close();
  const shared = await openPage(origin, { width: 390, height: 844 }, "/s/AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  await step("Жив сайт: спрян линк показва „не е достъпен“", async () => {
    await shared.page.waitForTimeout(1500);
    expect((await shared.page.textContent("#sharedTitle")).includes("не е достъпен"), "няма съобщение");
    expect(!shared.errors.length, shared.errors[0]);
  });
  await shared.page.close();
}

if (publicOrigin) {
  await publicChecks(publicOrigin);
} else {
  const stub = await startStubServer();
  await signedInFlows(stub.origin, stub.requests, "Телефон", { width: 390, height: 844 });
  await signedInFlows(stub.origin, stub.requests, "Компютър", { width: 1280, height: 800 });
  await sharedPage(stub.origin);
  stub.server.close();
}
await browser.close();
console.log(results.join("\n"));
console.log(`\nРобот: ${results.length - failed} минаха, ${failed} не минаха.`);
process.exit(failed ? 1 : 0);
