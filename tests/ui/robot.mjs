// Browser robot: opens the real page in Chromium and presses the buttons a
// person would, on a phone-sized and a desktop-sized screen.
//   node tests/ui/robot.mjs            → against the local stub server
//   node tests/ui/robot.mjs --public https://cloudaicore.com
//                                      → signed-out checks on the live site
import { makeZip } from "./make-zip.mjs";
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

async function signedInFlows(origin, requests, label, viewport, feedback) {
  const { page, errors } = await openPage(origin, viewport);
  const last = () => page.locator(".assistant-turn").last();
  // The person's own things are in the "Моят аватар" group of the side menu.
  const openMine = async (key) => {
    if (await page.locator("#mobileMenuBtn").isVisible()) {
      await page.click("#mobileMenuBtn");
      await page.waitForTimeout(300);
    }
    await page.click(`.mine-group [data-plus="${key}"]`);
  };
  const send = async (text) => {
    await page.fill("#chatInput", text);
    await page.click("#sendBtn");
  };
  const pickSpecialist = async (id) => {
    await page.click("#assistantPickerBtn");
    await page.click(`.assistant-picker button[data-assistant="${id}"]`);
  };
  const pickNone = async () => {
    await page.click("#assistantPickerBtn");
    await page.click(".assistant-picker .assistant-none");
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
  await step(`${label}: „Запази в Google“ прави Google документ от отговора`, async () => {
    await last().locator('[data-action="save-google"]').click();
    const kinds = await page.locator(".save-google-menu button").allInnerTexts();
    expect(kinds.join("|") === "Google документ", `менюто е ${kinds.join("|")}`);
    await page.locator(".save-google-menu button", { hasText: "Google документ" }).click();
    const note = last().locator(".save-google-note");
    await note.locator("a").waitFor({ timeout: 5000 });
    expect((await note.innerText()).includes("Запазено като Google документ"), "няма потвърждение");
    expect((await note.locator("a").getAttribute("href")).startsWith("https://docs.google.com/document/"), "няма линк към документа");
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
    await page.click("#assistantPickerBtn");
    await page.locator(".assistant-picker button", { hasText: "Юрист" }).click();
    expect((await page.textContent("#assistantPickerBtn")).includes("Юрист"), "горе не пише избрания специалист");
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
  await step(`${label}: менюто „+“ е кратко, личното е в „Моят аватар“`, async () => {
    await page.click("#attachBtn");
    // "Направи видео" is shown to the owner only until it opens for everyone.
    const rows = (await page.getAttribute("body", "data-user-role")) === "owner" ? 7 : 6;
    expect((await page.locator(".plus-menu > button:visible").count()) === rows, `менюто „+“ не е с ${rows} реда`);
    expect(!(await page.locator('.plus-menu [data-plus="assistant"]').count()), "специалистът е и в „+“ (двоен бутон)");
    await page.keyboard.press("Escape");
    expect((await page.locator(".mine-group [data-plus]").count()) === 8, "няма група „Моят аватар“");
    expect((await page.locator(".mine-group #memoryBtn").count()) === 1, "„Памет“ не е в групата");
  });
  await step(`${label}: „Чат“ показва моделите за чат, „Работа“ — моделите за работа`, async () => {
    await page.click("#workModeToolbarBtn");
    await page.waitForTimeout(300);
    await page.click("#modelPickerBtn");
    let menu = await page.locator("#modelPickerMenu").innerText();
    expect(menu.includes("GPT-5.6 Sol") && !menu.includes("Gemini 3.5 Flash Lite"), `в „Работа“ се виждат чат модели: ${menu}`);
    await page.locator("#modelPickerMenu button", { hasText: "GPT-5.6 Sol" }).click();
    expect((await page.textContent("#modelPickerLabel")).includes("GPT-5.6 Sol"), "моделът за работа не се избра");
    await page.click("#chatModeBtn");
    await page.waitForTimeout(300);
    await page.click("#modelPickerBtn");
    menu = await page.locator("#modelPickerMenu").innerText();
    expect(menu.includes("Gemini 3.5 Flash Lite") && !menu.includes("GPT-5.6 Sol"), `в „Чат“ се виждат модели за работа: ${menu}`);
    await page.keyboard.press("Escape");
  });
  await step(`${label}: обикновен акаунт няма превключвател „Чат/Работа“`, async () => {
    expect(await page.locator("#interactionModeBar").isVisible(), "собственикът не вижда превключвателя");
    await page.click("#workModeToolbarBtn");
    await page.evaluate(() => (document.body.dataset.userRole = "member"));
    await page.waitForTimeout(200);
    expect(!(await page.locator("#interactionModeBar").isVisible()), "превключвателят се вижда на член");
    expect((await page.evaluate(() => document.body.dataset.interactionMode)) === "chat", "членът остана в Работа");
    await page.evaluate(() => (document.body.dataset.userRole = "owner"));
  });
  await step(`${label}: началните карти са лични`, async () => {
    const fresh = (await page.locator("#mobileNewChatBtn").isVisible()) ? "#mobileNewChatBtn" : "#newChatBtn";
    await page.click(fresh);
    await page.waitForTimeout(400);
    const cards = await page.locator("#quickStart").innerText();
    expect(cards.includes("Моят ден") && cards.includes("Помогни ми да реша") && cards.includes("Какво знаеш за мен"), "картите не са новите");
    await page.click('#quickStart [data-starter*="Решението остава мое"]');
    expect((await page.inputValue("#chatInput")).includes("Решението остава мое"), "картата не попълни полето");
    await page.fill("#chatInput", "");
  });
  await step(`${label}: специалист от бутона горе, до модела; един „Нов разговор“`, async () => {
    const fresh = (await page.locator("#mobileNewChatBtn").isVisible()) ? "#mobileNewChatBtn" : "#newChatBtn";
    await page.click(fresh);
    await page.waitForTimeout(400);
    const newChats = await page.locator("#newChatBtn:visible, #mobileNewChatBtn:visible").count();
    expect(newChats === 1, `бутоните „Нов разговор“ на екрана са ${newChats}`);
    expect(!(await page.locator("#quickStart .assistant-row").count()), "специалистите са и на началния екран (двойни бутони)");
    expect(await page.locator("#assistantPickerBtn").isVisible(), "няма бутон за специалист горе");
    await page.click("#assistantPickerBtn");
    await page.locator(".assistant-picker button", { hasText: "Лекар" }).click();
    expect((await page.textContent("#assistantPickerBtn")).includes("Лекар"), "специалистът не е избран");
    await send("Какво значи висок холестерол?");
    await page.waitForTimeout(900);
    expect(requests.at(-1).assistant === "doctor", "специалистът не е изпратен");
    await pickNone();
  });
  await step(`${label}: специалистът показва инструментите си, а списък става задачи`, async () => {
    const fresh = (await page.locator("#mobileNewChatBtn").isVisible()) ? "#mobileNewChatBtn" : "#newChatBtn";
    await page.click(fresh);
    await page.waitForTimeout(400);
    await pickSpecialist("accountant");
    await page.locator(".assistant-tools .assistant-tool").first().waitFor({ timeout: 5000 });
    const tools = await page.locator(".assistant-tools").innerText();
    expect(tools.includes("Gmail") && tools.includes("Търсене в интернет"), `няма инструменти: ${tools}`);
    expect(await page.locator(".assistant-tools .assistant-tool-connect").isVisible(), "няма „Свържи Google“");
    expect(await page.locator('.assistant-tools [data-tool="gmail"]').isDisabled(), "Gmail работи без връзка");
    await pickNone();
    expect(await page.locator(".assistant-tools").isHidden(), "инструментите останаха без асистент");
    await pickSpecialist("chef");
    await page.locator(".assistant-tools .assistant-tool").first().waitFor({ timeout: 5000 });
    expect(!(await page.locator(".assistant-tools .assistant-tool-connect").count()), "готвачът не иска Google");
    await page.click('.assistant-tools [data-tool="youtube"]');
    const prefilled = await page.inputValue("#chatInput");
    expect(prefilled.startsWith("Обобщи това видео:"), `YouTube не подготви въпроса: ${prefilled}`);
    expect(await page.evaluate(() => document.activeElement?.id === "chatInput"), "полето не е на фокус");
    await page.fill("#chatInput", "");
    expect(await page.locator('.assistant-tools [data-tool="maps"]').isVisible(), "готвачът няма Карти");
    await page.click('.assistant-tools [data-tool="todos"]');
    await page.locator(".todo-dialog").waitFor({ state: "visible", timeout: 5000 });
    await page.locator(".todo-dialog .share-close").click();
    const before = await page.evaluate(async () => (await (await fetch("/api/todos")).json()).items.length);
    await send("Направи ми списък за пазар");
    await last().locator(".answer-todos").waitFor({ timeout: 5000 });
    expect((await last().locator(".answer-todos").innerText()).includes("(3)"), "бутонът не брои 3 точки");
    await last().locator(".answer-todos").click();
    await page.waitForTimeout(400);
    const after = await page.evaluate(async () => (await (await fetch("/api/todos")).json()).items);
    expect(after.length === before + 3, `задачите не се добавиха (${before} → ${after.length})`);
    expect(after.some((item) => item.text === "Яйца"), "звездичките не бяха махнати");
    // Leave the list as it was, so the later "Моите задачи" step starts clean.
    await page.evaluate(async (ids) => {
      for (const id of ids) await fetch(`/api/todos/${id}`, { method: "DELETE" });
    }, after.slice(0, 3).map((item) => item.id));
    await pickNone();
  });
  await step(`${label}: „Добавки“: пиша код, пробвам го, одобрявам го и всеки го пуска`, async () => {
    await openMine("addons");
    const box = page.locator(".addon-dialog");
    await box.waitFor({ state: "visible", timeout: 5000 });
    await box.locator('[data-tab="mine"]').click();
    const name = `Времето ${label}`;
    await box.locator('.addon-editor [name="name"]').fill(name);
    await box.locator(".addon-test").click();
    await box.locator(".addon-editor + .addon-output").waitFor({ state: "visible", timeout: 8000 });
    const tried = await box.locator(".addon-editor + .addon-output").innerText();
    expect(tried.includes("7.5°C"), `пробата не върна времето: ${tried}`);
    await box.locator(".addon-save").click();
    const mineRow = box.locator(".addon-mine .addon-item", { hasText: name });
    await mineRow.waitFor({ timeout: 5000 });
    expect((await mineRow.innerText()).includes("Само за мен"), "новата добавка не е лична");
    await mineRow.locator('[data-action="submit"]').click();
    await mineRow.locator(".addon-pending").waitFor({ timeout: 5000 });
    await box.locator('[data-tab="review"]').click();
    const reviewRow = box.locator(".addon-review .addon-item", { hasText: name });
    await reviewRow.waitFor({ timeout: 5000 });
    expect((await reviewRow.locator(".addon-code").textContent()).includes("function run"), "прегледът не показва кода");
    await reviewRow.locator('[data-action="approve"]').click();
    await reviewRow.waitFor({ state: "detached", timeout: 5000 });
    await box.locator('[data-tab="store"]').click();
    const storeRow = box.locator('[data-pane="store"] .addon-item', { hasText: name });
    await storeRow.waitFor({ timeout: 5000 });
    await storeRow.locator('[data-action="run-store"]').click();
    await storeRow.locator(".addon-output").waitFor({ state: "visible", timeout: 8000 });
    expect((await storeRow.locator(".addon-output").innerText()).includes("7.5°C"), "добавката от магазина не работи");
    await storeRow.locator('[data-action="to-chat"]').click();
    expect((await page.inputValue("#chatInput")).includes("7.5°C"), "резултатът не стигна до чата");
    expect(await box.isHidden(), "прозорецът не се затвори");
    await page.fill("#chatInput", "");
  });
  await step(`${label}: „Работа с Claude“ връща текст и файл за изтегляне`, async () => {
    await openMine("addons");
    const box = page.locator(".addon-dialog");
    await box.waitFor({ state: "visible", timeout: 5000 });
    const pane = box.locator('[data-pane="claude"]');
    await pane.waitFor({ state: "visible", timeout: 5000 });
    await pane.locator('input[name="skill"][value="pptx"]').check();
    await pane.locator('[name="task"]').fill("Реклама за Novarium");
    await pane.locator(".claude-work-run").click();
    await pane.locator(".claude-work-output").waitFor({ state: "visible", timeout: 8000 });
    expect((await pane.locator(".claude-work-output").innerText()).includes("Реклама за Novarium (pptx)"), "Claude не върна текста");
    const link = pane.locator(':scope > .claude-work-files a', { hasText: "reklama.pptx" });
    await link.waitFor({ timeout: 5000 });
    expect((await link.getAttribute("href")) === "/api/claude-work/files/file_robot", "връзката към файла е грешна");
    await box.locator(".share-close").click();
  });
  await step(`${label}: умение за Claude се прави в „Добавки“ и се ползва в „Работа с Claude“`, async () => {
    await openMine("addons");
    const box = page.locator(".addon-dialog");
    await box.waitFor({ state: "visible", timeout: 5000 });
    await box.locator('[data-tab="mine"]').click();
    await box.locator('.addon-editor [name="kind"]').selectOption("skill");
    expect(await box.locator('.addon-editor [name="code"]').isHidden(), "кодът се вижда при умение");
    const name = `Реклами ${label}`;
    await box.locator('.addon-editor [name="name"]').fill(name);
    await box.locator('.addon-editor [name="instructions"]').fill("Пиши кратки и весели реклами.");
    await box.locator(".addon-save").click();
    const row = box.locator(".addon-mine .addon-item", { hasText: name });
    await row.waitFor({ timeout: 5000 });
    await row.locator('[data-action="use-claude"]').click();
    const pane = box.locator('[data-pane="claude"]');
    await pane.waitFor({ state: "visible", timeout: 5000 });
    const choice = pane.locator(".claude-work-addons label", { hasText: name }).locator("input");
    await choice.waitFor({ timeout: 5000 });
    expect(await choice.isChecked(), "умението не е избрано");
    await pane.locator('[name="task"]').fill("Реклама");
    await pane.locator(".claude-work-run").click();
    await pane.locator(".claude-work-output").waitFor({ state: "visible", timeout: 8000 });
    await page.waitForFunction(() => document.querySelector(".claude-work-output")?.textContent.startsWith("Умения:"), null, { timeout: 8000 });
    expect((await pane.locator(".claude-work-output").innerText()).includes(name), "умението не стигна до Claude");
    await row.locator('[data-action="delete"]').click().catch(() => null);
    await box.locator(".share-close").click();
  });
  await step(`${label}: запис от среща става обобщение и задачи`, async () => {
    await page.click("#attachBtn");
    const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await page.click('.plus-menu [data-plus="meeting"]');
    await (await chooser).setFiles({ name: "среща.m4a", mimeType: "audio/mp4", buffer: Buffer.alloc(4096, 1) });
    await last().locator(".answer-todos").waitFor({ timeout: 8000 });
    const sent = requests.find((item) => item.meeting);
    expect(sent?.type === "audio/mp4" && sent.name === "среща.m4a" && sent.size === 4096, `записът не стигна: ${JSON.stringify(sent)}`);
    const answer = await last().innerText();
    expect(answer.includes("Среща за бюджета") && answer.includes("Моите файлове"), `няма обобщение: ${answer.slice(0, 200)}`);
    expect((await last().locator(".answer-todos").innerText()).includes("(2)"), "бутонът не брои 2 задачи");
    const before = await page.evaluate(async () => (await (await fetch("/api/todos")).json()).items.length);
    await last().locator(".answer-todos").click();
    await page.waitForTimeout(400);
    const after = await page.evaluate(async () => (await (await fetch("/api/todos")).json()).items);
    expect(after.length === before + 2, "задачите от срещата не се добавиха");
    await page.evaluate(async (ids) => {
      for (const id of ids) await fetch(`/api/todos/${id}`, { method: "DELETE" });
    }, after.slice(0, 2).map((item) => item.id));
  });
  await step(`${label}: собствен асистент`, async () => {
    await page.click("#assistantPickerBtn");
    await page.click(".assistant-picker .library-add");
    await page.fill(".library-form input", "Моят счетоводител");
    await page.fill(".library-form textarea", "Отговаряй като счетоводител.");
    await page.click(".library-form .primary");
    await page.waitForTimeout(400);
    expect((await page.textContent("#assistantPickerBtn")).includes("Моят счетоводител"), "асистентът не е избран");
    await send("Въпрос към моя асистент");
    await page.waitForTimeout(900);
    expect(String(requests.at(-1).assistant).startsWith("custom:"), "собственият асистент не е изпратен");
    await pickNone();
  });
  await step(`${label}: собствена подсказка`, async () => {
    await page.type("#chatInput", "/зап");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.fill(".library-form input", "оферта");
    await page.fill(".library-form textarea", "Напиши оферта за ");
    await page.click(".library-form .primary");
    await page.waitForTimeout(400);
    await page.type("#chatInput", "/оф");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    expect((await page.inputValue("#chatInput")).startsWith("Напиши оферта за"), "подсказката не попълни полето");
    await page.fill("#chatInput", "");
    await page.locator("#chatInput").dispatchEvent("input");
  });
  await step(`${label}: „Моите файлове“ — добави и изтрий`, async () => {
    await page.click("#attachBtn");
    await page.click('[data-plus="knowledge"]');
    await page.waitForTimeout(300);
    await page.setInputFiles(".knowledge-input", {
      name: "ceni.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Цената на услугата е 120 лева на месец."),
    });
    await page.waitForTimeout(500);
    expect((await page.locator(".knowledge-list").innerText()).includes("ceni.txt"), "файлът не се появи");
    await page.locator(".knowledge-list li button").first().click();
    await page.waitForTimeout(500);
    expect(!(await page.locator(".knowledge-list").innerText()).includes("ceni.txt"), "файлът не се изтри");
    await page.click(".knowledge-dialog .share-close");
  });
  await step(`${label}: архив от Google Takeout влиза в „Моите файлове“`, async () => {
    const zip = makeZip([
      ["Takeout/Keep/Идея.json", JSON.stringify({ title: "Идея", textContent: "Аватар за всеки човек, безплатно.", userEditedTimestampUsec: 1.7e15 })],
    ]);
    await page.click("#attachBtn");
    await page.click('[data-plus="knowledge"]');
    await page.waitForTimeout(300);
    await page.setInputFiles(".archive-input", {
      name: "takeout.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(await zip.arrayBuffer()),
    });
    await page.waitForTimeout(1200);
    expect((await page.locator(".knowledge-list").innerText()).includes("Google Keep"), "архивът не се добави");
    await page.locator(".knowledge-list li button").first().click();
    await page.waitForTimeout(400);
    await page.click(".knowledge-dialog .share-close");
  });
  await step(`${label}: „Моят аватар“ — запиши, отвори пак, изтрий`, async () => {
    await openMine("avatar");
    await page.waitForTimeout(400);
    await page.fill('.avatar-form textarea[name="about"]', "Казвам се Робот и проверявам сайта.");
    await page.click(".avatar-save");
    await page.waitForTimeout(400);
    await page.click(".avatar-dialog .share-close");
    await openMine("avatar");
    await page.waitForTimeout(400);
    expect(
      (await page.inputValue('.avatar-form textarea[name="about"]')).includes("Робот"),
      "профилът не се запази",
    );
    await page.click(".avatar-clear");
    await page.waitForTimeout(400);
    expect((await page.inputValue('.avatar-form textarea[name="about"]')) === "", "профилът не се изтри");
    await page.click(".avatar-dialog .share-close");
  });
  await step(`${label}: „Моят Google“ показва бутона за свързване`, async () => {
    await openMine("google");
    await page.waitForTimeout(500);
    expect(await page.locator("#connectGoogleDrive").isVisible(), "няма бутон за свързване");
    expect((await page.locator("#restoreGoogleDrive").count()) === 0, "бутонът за възстановяване се вижда");
    await page.click("#closeDataDrawerBtn");
    await page.waitForTimeout(200);
  });
  await step(`${label}: „Моят Google“ след свързване казва какво работи, без грешка`, async () => {
    await page.evaluate(() => fetch("/__robot/google-light"));
    await openMine("google");
    await page.waitForTimeout(500);
    const drawerText = await page.locator("#dataDrawerBody").innerText();
    expect(drawerText.includes("Google е свързан"), `няма „Google е свързан“: ${drawerText.slice(0, 80)}`);
    expect((await page.locator('#dataDrawerBody a[href*="add=drive"]').count()) === 0, "предлага целия Drive");
    expect(await page.locator("#disconnectGoogleDrive").isVisible(), "няма „Прекъсни връзката“");
    await page.evaluate(() => fetch("/__robot/google-disconnected"));
    await page.click("#closeDataDrawerBtn");
    await page.waitForTimeout(200);
  });
  await step(`${label}: „Чернова от мое име“ записва отговор като чернова`, async () => {
    await page.evaluate(() => fetch("/__robot/google-connected"));
    await openMine("google");
    await page.waitForTimeout(500);
    await page.click("#openMyMail");
    await page.waitForTimeout(500);
    await page.click(".reply-draft");
    await page.waitForTimeout(500);
    const result = await page.locator(".reply-draft-result").innerText();
    expect(result.includes("Здравей, Иване!"), "черновата не се показа");
    expect(result.includes("изпрати сам"), "липсва връзката към черновата");
    await page.evaluate(() => fetch("/__robot/google-disconnected"));
    await page.click("#closeDataDrawerBtn");
    await page.waitForTimeout(200);
  });
  await step(`${label}: „Инструменти“ показва „Работи“ само след истинска проверка`, async () => {
    await page.evaluate(() => fetch("/__robot/google-connected"));
    // The button sits under "Още" in the side menu; press it directly so the
    // phone's side menu stays closed.
    await page.evaluate(() => document.getElementById("toolsBtn").click());
    await page.locator('[data-live-check="google:gmail"].allow').waitFor({ timeout: 5000 });
    const gmail = await page.locator('[data-live-check="google:gmail"]').innerText();
    expect(gmail.startsWith("Работи · проверено"), `Gmail: ${gmail}`);
    const contacts = page.locator('[data-live-check="google:contacts"]');
    expect((await contacts.innerText()) === "Не отговаря", "отказалите Contacts светят зелено");
    expect((await page.locator(".tool-live-reason", { hasText: "контактите" }).count()) === 1, "няма причина за отказа");
    const youtube = page.locator('[data-live-check="google:youtube"]');
    expect((await youtube.innerText()) === "Още не е разрешен", "неразрешеният YouTube е показан като повреден");
    expect((await page.locator('a.tool-connect-btn[href="/api/google/connect?add=youtube"]').count()) === 1, "няма бутон „Разреши“ за YouTube");
    // Tools without a Google call get their own real check too.
    await page.locator('[data-live-check="core:openai-web-search"].allow').waitFor({ timeout: 5000 });
    const photos = await page.locator(".tool-status-card", { hasText: "Снимки" }).innerText();
    expect(photos.includes("Не отговаря") && photos.includes("претоварен"), `снимките светят без проверка: ${photos}`);
    await page.evaluate(() => fetch("/__robot/google-disconnected"));
    await page.click("#closeDataDrawerBtn");
    await page.waitForTimeout(200);
  });
  await step(`${label}: „Активност“ показва хората, съобщенията и рекламите`, async () => {
    await page.evaluate(() => document.getElementById("activityBtn").click());
    await page.locator(".activity-table tbody tr").first().waitFor({ timeout: 5000 });
    const totals = await page.locator(".activity-totals").innerText();
    expect(totals.includes("41") && totals.includes("9"), `сборовете са грешни: ${totals}`);
    expect(totals.includes("регистрирани общо") && totals.includes("7"), `няма всички регистрирани: ${totals}`);
    expect((await page.locator(".activity-table tbody tr").count()) === 2, "липсват дни");
    expect((await page.locator(".activity-table tbody tr").first().innerText()).includes("5 / 1 / 0"), "рекламата не е по варианти");
    await page.click("#closeDataDrawerBtn");
    await page.waitForTimeout(200);
  });
  await step(`${label}: „Моят ден“ показва плана в разговора`, async () => {
    await openMine("day");
    await page.waitForTimeout(600);
    const reply = await last().innerText();
    expect(reply.includes("Най-важното днес"), "планът не се показа");
    expect(reply.includes("Моят Google"), "липсва подсказката за свързване");
    await last().locator(".morning-toggle").click();
    expect(
      (await last().locator(".morning-toggle").getAttribute("aria-pressed")) === "true",
      "бутонът „всяка сутрин“ не се включи",
    );
    expect((await page.evaluate(() => localStorage.getItem("novarium-morning-plan"))) === "on", "изборът не се запази");
  });
  await step(`${label}: „Моята седмица“ показва прегледа и може да идва сама всеки понеделник`, async () => {
    await openMine("week");
    await page.waitForTimeout(600);
    expect((await last().innerText()).includes("Трите най-важни за седмицата"), "прегледът не се показа");
    await last().locator('.morning-toggle[data-period="week"]').click();
    expect((await page.evaluate(() => localStorage.getItem("novarium-weekly-plan"))) === "on", "изборът не се запази");
  });
  await step(`${label}: „Моите задачи“: бележка става на задачи, отмятане и изтриване`, async () => {
    await openMine("todos");
    await page.waitForTimeout(400);
    const box = page.locator(".todo-dialog");
    expect(await box.isVisible(), "прозорецът не се отвори");
    await box.locator("#todoNote").fill("утре да се обадя на счетоводителя и да платя тока до петък");
    await box.locator(".todo-make").click();
    await page.waitForTimeout(400);
    expect((await box.locator(".todo-suggestions input:checked").count()) === 2, "няма две предложени задачи");
    await box.locator(".todo-suggestions input").nth(1).uncheck();
    await box.locator(".todo-keep").click();
    await page.waitForTimeout(400);
    expect((await box.locator(".todo-list .todo-check").count()) === 1, "не се запази само избраната");
    await box.locator("#todoAdd").fill("Купи подарък");
    await box.locator(".todo-add button").click();
    await page.waitForTimeout(400);
    expect((await box.locator(".todo-list .todo-check").count()) === 2, "ръчната задача не се добави");
    const doneBefore = Number((await box.locator(".todo-done-count").innerText()).replace(/\D/gu, "") || 0);
    await box.locator(".todo-list .todo-check").first().check();
    await page.waitForTimeout(400);
    const doneAfter = Number((await box.locator(".todo-done-count").innerText()).replace(/\D/gu, "") || 0);
    expect(doneAfter === doneBefore + 1, "отметнатата не отиде в готови");
    await box.locator(".todo-remove").first().click();
    await page.waitForTimeout(400);
    expect((await box.locator(".todo-list .todo-check").count()) === 0, "задачата не се изтри");
  });
  // Close the window even when a check above failed, so the next steps can click.
  if (await page.locator(".todo-dialog").isVisible()) await page.locator(".todo-dialog .share-close").click();
  await step(`${label}: „Питай моя аватар“: линк, въпрос от посетител и спиране`, async () => {
    await openMine("link");
    const box = page.locator(".avatar-link-dialog");
    await box.waitFor({ state: "visible", timeout: 5000 });
    await box.locator("#avatarLinkName").fill("Мария");
    await box.locator("#avatarLinkKnowledge").fill("Работя от 9 до 17 ч.");
    await box.locator(".avatar-link-save").click();
    await page.waitForFunction(() => document.querySelector(".avatar-link-url input")?.value.includes("/a/"), null, { timeout: 5000 }).catch(() => {});
    const url = await box.locator(".avatar-link-url input").inputValue();
    expect(url.includes("/a/"), "няма линк");
    const visitor = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "bg-BG" });
    // Wait for the card to load instead of a fixed pause; the CI machine is slower than a laptop.
    const nameShown = (want) => visitor.waitForFunction((text) => document.getElementById("avatarName")?.textContent.includes(text), want, { timeout: 8000 }).catch(() => {});
    await visitor.goto(url, { waitUntil: "domcontentloaded" });
    await nameShown("Мария");
    const shownName = await visitor.textContent("#avatarName");
    expect(shownName.includes("Мария"), `посетителят не вижда името (вижда: ${shownName.trim().slice(0, 80)})`);
    await visitor.fill("#avatarQuestion", "Кога работиш?");
    await visitor.click("#avatarAsk button");
    await visitor.waitForFunction(() => document.querySelectorAll(".shared-message.agent").length >= 2 && !document.getElementById("avatarAsk")?.dataset.busy, null, { timeout: 8000 }).catch(() => {});
    expect((await visitor.locator(".shared-message.agent").last().innerText()).includes("9 до 17"), "няма отговор за посетителя");
    await box.locator(".avatar-link-stop").click();
    await page.waitForTimeout(400);
    await visitor.reload();
    await nameShown("не е достъпен");
    expect((await visitor.textContent("#avatarName")).includes("не е достъпен"), "спреният линк още работи");
    await visitor.close();
  });
  if (await page.locator(".avatar-link-dialog").isVisible()) await page.locator(".avatar-link-dialog .share-close").click();
  await step(`${label}: „Нарисувай картинка“ показва картинката`, async () => {
    await page.fill("#chatInput", "котка на луната");
    await page.click("#attachBtn");
    await page.click('[data-plus="draw"]');
    await page.waitForTimeout(600);
    expect((await last().locator(".generated-image img").count()) === 1, "няма картинка");
    expect((await last().locator(".generated-image a[download]").count()) === 1, "няма бутон за изтегляне");
  });
  await step(`${label}: „Отвори отстрани“ показва документа и графика от таблица`, async () => {
    await page.evaluate(() =>
      globalThis.SynchronChat.append(
        "agent",
        "## Разходи\n\n| Месец | Сума |\n|---|---|\n| Януари | 120 |\n| Февруари | 80,50 |\n| Март | 200 |",
      ),
    );
    await last().locator('button[data-action="open-panel"]').click();
    await page.waitForTimeout(300);
    expect(await page.locator(".doc-panel").isVisible(), "панелът не се отвори");
    expect((await page.locator(".doc-panel-body").innerText()).includes("Разходи"), "липсва текстът");
    await page.click(".doc-chart-button");
    expect((await page.locator(".doc-panel .doc-chart rect").count()) === 3, "графиката няма три стълба");
    await page.click('.doc-panel [data-doc="close"]');
    expect(!(await page.locator(".doc-panel").isVisible()), "панелът не се затвори");
  });
  await step(`${label}: „Каузи“ — предложи, харесай, изтрий`, async () => {
    await openMine("causes");
    await page.waitForTimeout(400);
    await page.fill(".causes-form input", "Детска площадка");
    await page.fill(".causes-form textarea", "Нова площадка за децата в квартала.");
    await page.click(".causes-form button");
    await page.waitForTimeout(400);
    expect((await page.locator(".causes-list").innerText()).includes("Детска площадка"), "каузата не се появи");
    await page.click(".cause-prepare");
    await page.waitForTimeout(400);
    await page.click(".cause-project summary");
    expect((await page.locator(".cause-project-text").innerText()).includes("Цел"), "проектът не се показа");
    await page.click(".cause-like");
    await page.waitForTimeout(300);
    expect((await page.locator(".cause-like").innerText()).includes("0"), "харесването не се смени");
    await page.click(".cause-remove");
    await page.waitForTimeout(300);
    expect(!(await page.locator(".causes-list").innerText()).includes("Детска площадка"), "каузата не се изтри");
    await page.click(".causes-dialog .share-close");
  });
  await step(`${label}: търсене в интернет с източници`, async () => {
    await page.fill("#chatInput", "Какво ново днес?");
    await page.click("#attachBtn");
    await page.click('[data-plus="search"]');
    await page.waitForTimeout(600);
    const reply = await last().innerText();
    expect(reply.includes("Намерен отговор.") && reply.includes("Източник едно"), "няма отговор с източник");
    expect(!(await page.locator("#chatInput").isDisabled()), "полето остана заключено");
  });
  await step(`${label}: „Потвърди“ изпълнява подготвеното събитие`, async () => {
    await send("Създай събитие в календара: Демо | 2026-11-28 10:00 | 30");
    await page.waitForTimeout(900);
    const reply = await last().innerText();
    expect(reply.includes("Подготвих, но още нищо не е направено"), "няма подготвеното действие");
    const confirm = last().locator(".next-step-confirm");
    expect(await confirm.isVisible(), "няма бутон „Потвърди“");
    await confirm.click();
    await page.waitForTimeout(900);
    expect(
      (await page.locator(".user-turn").last().innerText()).includes("Потвърждавам Novarium задача: 11111111-2222-3333-4444-555555555555"),
      "бутонът не изпрати точната команда",
    );
    expect((await last().innerText()).includes("Календарното събитие е създадено: Демо"), "събитието не е потвърдено");
  });
  await step(`${label}: „Откъде знам това“ под отговора`, async () => {
    await send("Откъде знаеш рождения ми ден?");
    await page.waitForTimeout(1200);
    const chips = last().locator(".answer-source");
    expect((await chips.count()) === 2, "няма двата източника под отговора");
    expect((await chips.first().innerText()).includes("Бележки.pdf"), "липсва името на файла");
    await send("Здравей пак");
    await page.waitForTimeout(1200);
    expect((await last().locator(".answer-sources").count()) === 0, "има източници там, където няма такива");
  });
  await step(`${label}: Съвет в колони`, async () => {
    await page.click("#attachBtn");
    await page.click('[data-plus="models"]');
    await page.click('[data-plus="council"]');
    await send("Въпрос за Съвета");
    await page.waitForTimeout(900);
    expect(requests.at(-1).council === true, "Съветът не е включен в заявката");
    expect((await page.locator(".council-card").count()) === 2, "няма две колони");
  });
  await step(`${label}: 👍 се записва за модела`, async () => {
    const before = feedback.length;
    const like = page.locator('.assistant-turn[data-provider] [data-action="like"]').last();
    await like.scrollIntoViewIfNeeded();
    await like.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    expect(feedback.length === before + 1 && feedback.at(-1).kind === "up", "оценката не е изпратена");
    expect(Boolean(feedback.at(-1).provider), "липсва модел в оценката");
  });
  await step(`${label}: сляпо сравнение`, async () => {
    await page.fill("#chatInput", "Кое е по-добро?");
    await page.click("#attachBtn");
    await page.click('[data-plus="models"]');
    await page.click('[data-plus="compare"]');
    await page.waitForTimeout(500);
    const box = page.locator(".compare-box").last();
    expect(!(await box.innerText()).includes("Claude"), "имената се виждат преди гласуване");
    await box.locator(".compare-votes button").first().click();
    await page.waitForTimeout(300);
    expect((await box.innerText()).includes("Claude Haiku 5.5"), "имената не се показаха след гласуване");
    expect(feedback.at(-1).votes?.[0]?.kind === "win", "гласът не е изпратен");
  });
  await step(`${label}: „Сподели разговора“`, async () => {
    await page.click("#chatOptions summary");
    await page.click("#conversationShareBtn");
    await page.click(".share-create");
    await page.waitForTimeout(400);
    expect((await page.inputValue(".share-link input")).includes("/s/"), "няма линк");
    await page.click(".share-close");
  });
  await step(`${label}: „всяка сутрин“ и „всеки понеделник“ идват сами при първото отваряне`, async () => {
    await page.evaluate(() => {
      localStorage.setItem("novarium-morning-plan-day", "2000-01-01");
      localStorage.setItem("novarium-weekly-plan-day", "2000-01-03");
    });
    await page.reload();
    await page.waitForTimeout(3500);
    const turns = await page.locator(".assistant-turn").allInnerTexts();
    expect(turns.some((turn) => turn.includes("Трите най-важни за седмицата")), "седмицата не дойде сама");
    expect((await last().innerText()).includes("Най-важното днес"), "планът не дойде сам");
    await page.reload();
    await page.waitForTimeout(2000);
    expect(!(await page.locator(".assistant-turn").last().innerText().catch(() => "")).includes("Най-важното днес"), "планът дойде втори път в същия ден");
    await page.evaluate(() => {
      localStorage.removeItem("novarium-morning-plan");
      localStorage.removeItem("novarium-weekly-plan");
    });
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

// The browser's microphone and voice are replaced by a script: the person
// "says" Здравей, hears the answer, then says "стоп".
async function talkFlow(origin, requests) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "bg-BG" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    window.__talkScript = ["Здравей", "стоп"];
    window.__listens = 0;
    window.__spoken = [];
    class FakeRecognition {
      start() {
        window.__listens += 1;
        const said = window.__talkScript.shift() || "";
        setTimeout(() => {
          this.onstart?.();
          if (said) {
            const result = [{ transcript: said }];
            result.isFinal = true;
            this.onresult?.({ resultIndex: 0, results: [result] });
          }
          setTimeout(() => this.onend?.(), 60);
        }, 60);
      }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        cancel() {},
        speak(utterance) {
          if (utterance.text) window.__spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 40);
        },
      },
    });
  });
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await step("Разговор с глас: слуша, праща сам, чете отговора и спира на „стоп“", async () => {
    const before = requests.length;
    expect(await page.locator("#talkBtn").isVisible(), "няма бутон за разговор с глас");
    expect(await page.locator("#sendBtn").isVisible(), "бутонът за изпращане излезе от екрана");
    await page.click("#talkBtn");
    await page.waitForTimeout(3500);
    expect(requests.length === before + 1, "съобщението не се изпрати само");
    expect((await page.locator(".user-message, .message.user").last().innerText()).includes("Здравей"), "не виждам „Здравей“ в разговора");
    const spoken = await page.evaluate(() => window.__spoken.join(" "));
    expect(spoken.length > 3, "отговорът не беше прочетен на глас");
    expect((await page.evaluate(() => window.__listens)) === 2, "не започна да слуша отново след отговора");
    expect(!(await page.evaluate(() => document.body.classList.contains("talk-mode"))), "„стоп“ не спря разговора");
    expect((await page.locator("#talkBtn").getAttribute("aria-pressed")) === "false", "бутонът остана включен");
    expect(!errors.length, errors[0]);
  });
  await page.close();
}

async function statusPage(origin, live) {
  const { page, errors } = await openPage(origin, { width: 390, height: 844 }, "/status");
  await step(`${live ? "Жив сайт" : "Страница"}: състоянието показва сайта и моделите`, async () => {
    // On the live site the check asks every model for a short answer, which
    // can take longer than a fixed wait (it was 4 s), so wait for the answer.
    await page
      .waitForFunction(() => document.getElementById("statusTitle")?.textContent !== "Проверка…", null, {
        timeout: live ? 45_000 : 3_000,
      })
      .catch(() => {});
    expect((await page.locator(".status-list li").count()) >= 2, "няма редове за сайта и моделите");
    expect((await page.textContent("#statusTitle")) !== "Проверка…", "страницата не се обнови");
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

// Signed in on the live site with a test account. Only free actions: no AI
// requests. The account's email and password come from GitHub secrets; without
// them these steps are skipped, not failed.
async function liveSignedIn(origin) {
  const email = process.env.ROBOT_TEST_EMAIL || "";
  const password = process.env.ROBOT_TEST_PASSWORD || "";
  if (!email || !password) {
    results.push("⏭ Жив сайт с вход: пропуснато, няма тестов профил (ROBOT_TEST_EMAIL / ROBOT_TEST_PASSWORD)");
    return;
  }
  const { page, errors } = await openPage(origin, { width: 390, height: 844 });
  const openMine = async (key) => {
    if (await page.locator("#mobileMenuBtn").isVisible()) {
      await page.click("#mobileMenuBtn");
      await page.waitForTimeout(300);
    }
    await page.click(`.mine-group [data-plus="${key}"]`);
  };
  await step("Жив сайт: вход с тестовия профил", async () => {
    // New profiles use Google; the old email/password sign-in is folded away.
    expect(await page.locator("#googleSignInBtn").isVisible(), "няма бутон „Продължи с Google“");
    expect((await page.locator("#registerForm").count()) === 0, "още има регистрация с имейл и парола");
    if (!(await page.locator("#loginEmail").isVisible())) {
      await page.click("#passwordSignIn summary");
    }
    await page.fill("#loginEmail", email);
    await page.fill("#loginPassword", password);
    await page.click("#loginBtn");
    await page.locator("#chatInput").waitFor({ state: "visible", timeout: 20000 });
    expect(await page.locator("#sendBtn").isVisible(), "няма бутон за изпращане");
  });
  await step("Жив сайт: специалистите се избират горе, има и разговор с глас", async () => {
    await page.click("#assistantPickerBtn");
    await page.waitForFunction(() => document.querySelectorAll(".assistant-picker [data-assistant]").length >= 13, null, { timeout: 8000 }).catch(() => {});
    const shown = await page.locator(".assistant-picker [data-assistant]").count();
    expect(shown >= 13, `няма 13 специалиста (вижда: ${shown})`);
    await page.keyboard.press("Escape");
    expect(await page.locator("#talkBtn").isVisible(), "няма бутон за разговор с глас");
  });
  await step("Жив сайт: групата „Моят аватар“ е пълна", async () => {
    const buttons = await page.locator(".mine-group [data-plus]").count();
    expect(buttons === 8, `групата не е с 8 бутона (вижда: ${buttons})`);
    expect((await page.locator('.mine-group [data-plus="link"]').count()) === 1, "няма „Питай моя аватар“");
    expect((await page.locator(".mine-group #memoryBtn").count()) === 1, "„Памет“ не е в групата");
  });
  await step("Жив сайт: „Моите задачи“ записва и трие задача", async () => {
    const label = `Робот проверка ${Date.now()}`;
    await openMine("todos");
    const box = page.locator(".todo-dialog");
    await box.waitFor({ state: "visible", timeout: 5000 });
    await box.locator("#todoAdd").fill(label);
    await box.locator(".todo-add button").click();
    const row = box.locator(".todo-list li", { hasText: label });
    await row.waitFor({ timeout: 10000 });
    await row.locator(".todo-remove").click();
    await row.waitFor({ state: "detached", timeout: 10000 });
  });
  if (await page.locator(".todo-dialog").isVisible()) await page.locator(".todo-dialog .share-close").click();
  await step("Жив сайт: „Добавки“: пробата чете данни от сайт и работи в затворена среда", async () => {
    // Only "Пробвай": nothing is saved on the live site.
    await openMine("addons");
    const box = page.locator(".addon-dialog");
    await box.waitFor({ state: "visible", timeout: 5000 });
    await box.locator('[data-tab="mine"]').click();
    await box.locator(".addon-new").click();
    await box.locator(".addon-test").click();
    const out = box.locator(".addon-test-output");
    await out.waitFor({ state: "visible", timeout: 15000 });
    const shown = await out.innerText();
    expect(/Сега в София: -?\d/u.test(shown), `пробата не върна времето: ${shown}`);
    const probe = await page.evaluate(async () => {
      const call = async (body) => (await fetch("/api/addons/test", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      })).json();
      return {
        closed: await call({ name: "p", code: "function run(){ return [typeof process, typeof require, typeof fetch].join(','); }" }),
        loop: await call({ name: "p", code: "function run(){ while (true) {} }" }),
        inside: await call({ name: "p", code: "function run(i, d){ return d; }", dataUrl: "https://metadata.google.internal/computeMetadata/v1/" }),
      };
    });
    expect(probe.closed.output === "undefined,undefined,undefined", `средата не е затворена: ${JSON.stringify(probe.closed)}`);
    expect(probe.loop.ok === false, "безкрайният цикъл не беше спрян");
    expect(!probe.inside.output, "вътрешен адрес беше прочетен");
    await box.locator(".share-close").click();
  });
  await step("Жив сайт: „Кой съм аз“ се зарежда", async () => {
    await openMine("avatar");
    const dialog = page.locator(".avatar-dialog");
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await page.waitForTimeout(2000);
    expect((await dialog.locator(".avatar-form textarea").count()) === 5, "полетата не се заредиха");
    await dialog.locator(".share-close").click();
  });
  await step("Жив сайт: без грешки в страницата след вход", async () => expect(!errors.length, errors[0]));
  await page.close();
}

if (publicOrigin) {
  await publicChecks(publicOrigin);
  await statusPage(publicOrigin, true);
  await liveSignedIn(publicOrigin);
} else {
  const stub = await startStubServer();
  await signedInFlows(stub.origin, stub.requests, "Телефон", { width: 390, height: 844 }, stub.feedback);
  await signedInFlows(stub.origin, stub.requests, "Компютър", { width: 1280, height: 800 }, stub.feedback);
  await sharedPage(stub.origin);
  await talkFlow(stub.origin, stub.requests);
  await statusPage(stub.origin, false);
  stub.server.close();
}
await browser.close();
console.log(results.join("\n"));
const skipped = results.filter((line) => line.startsWith("⏭")).length;
console.log(`\nРобот: ${results.length - failed - skipped} минаха, ${failed} не минаха${skipped ? `, ${skipped} пропуснати` : ""}.`);
process.exit(failed ? 1 : 0);
