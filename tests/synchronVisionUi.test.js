import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the personal AI interface keeps chat primary and makes owner mobile actions role-aware", async () => {
  const [html, css, script, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /\/assets\/20260806-green-chat-v1\/synchron-vision\.css/u);
  assert.match(html, /\/assets\/20260806-green-chat-v1\/synchron-vision\.js/u);
  assert.match(server, /mobileLayoutAssetVersion = "20260806-green-chat-v1"/u);
  assert.match(html, /class="mobile-command-bar"/u);
  assert.match(html, /data-command="chat"/u);
  assert.match(html, /data-command="memory"/u);
  assert.match(html, /data-command="connections"/u);
  assert.match(html, /data-command="connections"[^>]*data-owner-only/u);
  assert.match(html, /data-command="status"/u);
  assert.match(html, /id="taskRunList"/u);
  assert.doesNotMatch(html, /data-command="(?:work|tasks)"/u);
  assert.match(css, /\.mobile-command-bar/u);
  assert.match(css, /repeat\(auto-fit, minmax\(0, 1fr\)\)/u);
  assert.match(css, /\.mobile-command-bar button\[hidden\]/u);
  assert.match(css, /bottom:\s*calc\(70px \+ env\(safe-area-inset-bottom\)\)/u);
  assert.match(script, /forwardClick\("memoryBtn", "memory"\)/u);
  assert.match(script, /forwardClick\("workCenterBtn", "connections"\)/u);
  assert.match(script, /!target \|\| target\.hidden/u);
  assert.match(script, /forwardClick\("profileStatusBtn", "status"\)/u);
  assert.match(script, /setAttribute\("aria-current", "page"\)/u);
});

test("the chat composer is a labelled multiline control with bounded autosize", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(
    html,
    /<textarea[\s\S]*?id="chatInput"[\s\S]*?aria-label="Съобщение до AI CORE"[\s\S]*?><\/textarea>/u,
  );
  assert.match(css, /\.chat-input-area textarea\s*\{/u);
  assert.match(css, /max-height:\s*160px/u);
  assert.match(app, /function resizeChatInput\(\)/u);
  assert.match(app, /execute-council/u);
  assert.match(app, /showCouncilExecutionAction/u);
  assert.match(app, /function loadTaskRuns\(\)/u);
  assert.match(app, /data-run-action/u);
  assert.match(css, /council-execute-action/u);
  assert.match(css, /task-run-item/u);
  assert.match(app, /Math\.min\(naturalHeight, MAX_CHAT_INPUT_HEIGHT\)/u);
  assert.match(app, /chatInput\.addEventListener\("input", resizeChatInput\)/u);
});

test("status panel reports live Supabase health and honest backup evidence", async () => {
  const [
    html,
    app,
    css,
    shell,
    accessibility,
    mobileScript,
    legacyStyles,
    workCenter,
  ] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/appshell.css", import.meta.url), "utf8"),
    readFile(new URL("../public/accessibility.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/work-center.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="supabaseStatusDisplay"/u);
  assert.match(html, /id="opensearchBackupStatusDisplay"/u);
  assert.match(html, /id="supabaseBackupStatusDisplay"/u);
  assert.match(html, /class="legacy-status-details"/u);
  assert.match(html, /Наследени услуги и архив · само диагностика/u);
  assert.match(html, /Активни интеграции/u);
  assert.match(html, /Наличният инвентар не доказва успешно възстановяване/u);
  assert.match(app, /readHealthReport\("\/health\/dependencies"\)/u);
  assert.match(app, /readHealthReport\("\/health\/backups"\)/u);
  assert.match(
    app,
    /state\.storageOpenSearchHealthy = opensearch\?\.status === "healthy"/u,
  );
  assert.match(
    app,
    /state\.storageOpenSearchHealthy === false \? "unavailable" : status/u,
  );
  assert.match(app, /Проверено с реална заявка · работи/u);
  assert.match(app, /Инвентарът е проверен · restore не е тестван/u);
  assert.match(app, /Непроверен · backup политиката не е видима/u);
  assert.match(
    shell,
    /\.statusPanel\{[^}]*z-index:80;[^}]*flex-direction:column/u,
  );
  assert.match(
    css,
    /\.statusPanel\s*\{[^}]*z-index:\s*80\s*!important;[^}]*flex-direction:\s*column/u,
  );
  assert.match(
    css,
    /\.statusPanel \.panel-content\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1/u,
  );
  assert.match(css, /font-size:\s*var\(--synchron-small-text, 17px\)/u);
  assert.match(accessibility, /\.chat-input-area textarea/u);
  assert.match(app, /statusReturnFocus/u);
  assert.match(app, /activeElement === elements\.profileStatusBtn/u);
  assert.match(app, /new CustomEvent\("synchron:status-closed"\)/u);
  assert.match(app, /new CustomEvent\("synchron:data-drawer-closed"\)/u);
  assert.match(mobileScript, /synchron:status-closed/u);
  assert.match(mobileScript, /synchron:data-drawer-closed/u);
  assert.match(workCenter, /synchron:data-drawer-closed/u);
  assert.match(
    legacyStyles,
    /\.statusPanel \.close-btn\s*\{[^}]*display:\s*inline-flex/u,
  );
  assert.match(legacyStyles, /--success:\s*#087a42/u);
  assert.match(legacyStyles, /--error:\s*#b42335/u);
  assert.match(legacyStyles, /\.status-yellow\s*\{[^}]*#7c4a03/u);
  assert.doesNotMatch(legacyStyles, /#20b15a|#c58a00|#df3e4f/u);
});

test("a failed OpenSearch index probe stays authoritative across later memory events", async () => {
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const policyStart = app.indexOf("function markMemoryOperational()");
  const policyEnd = app.indexOf("function setServerStatus", policyStart);
  assert.ok(policyStart >= 0 && policyEnd > policyStart);

  const state = {
    lastMemorySuccessAt: 0,
    opensearchFailures: 0,
    storageOpenSearchHealthy: false,
  };
  const displayedStatuses = [];
  const createPolicy = new Function(
    "state",
    "updateOpenSearchUI",
    `${app.slice(policyStart, policyEnd)}\nreturn { markMemoryOperational, handleOpenSearchProbeFailure };`,
  );
  const policy = createPolicy(state, (status) =>
    displayedStatuses.push(status),
  );

  policy.markMemoryOperational();
  policy.handleOpenSearchProbeFailure("unreachable");
  assert.deepEqual(displayedStatuses, ["unavailable", "unavailable"]);

  state.storageOpenSearchHealthy = true;
  policy.markMemoryOperational();
  assert.equal(displayedStatuses.at(-1), "operational");
});

test("obsolete search and module shells are not loaded by the product UI", async () => {
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(html, /\/(?:search|modules)\.(?:js|css)/u);
  assert.doesNotMatch(html, /id="modulesBtn"/u);
});

test("the visual layer preserves the readable text controls and safe drawers", async () => {
  const css = await readFile(
    new URL("../public/synchron-vision.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /\.font-size-control/u);
  assert.match(css, /\.data-drawer/u);
  assert.match(css, /width:\s*100vw\s*!important/u);
  assert.match(css, /prefers-reduced-motion/u);
});

test("mobile conversation history stays reachable with very large text", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="searchChatsBtn"[\s\S]*?<span>Разговори<\/span>/u);
  assert.match(css, /\.sidebar\s*\{[\s\S]*?overflow-y:\s*auto\s*!important/u);
  assert.match(css, /\.sidebar-section\s*\{[\s\S]*?min-height:\s*180px/u);
  assert.match(
    app,
    /scrollIntoView\(\{ block: "start", behavior: "smooth" \}\)/u,
  );
  assert.match(app, /Историята временно не е достъпна/u);
  assert.match(app, /Все още няма запазени разговори/u);
});

test("desktop keeps the chat visible and both panes reachable with the mouse", async () => {
  const css = await readFile(
    new URL("../public/synchron-vision.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /@media \(min-width: 901px\)/u);
  assert.match(
    css,
    /\.app-shell > \.chatPanel\s*\{[\s\S]*?grid-area:\s*auto\s*!important;[\s\S]*?grid-column:\s*2;/u,
  );
  assert.match(
    css,
    /\.app-shell > \.sidebar\s*\{[\s\S]*?overflow-y:\s*auto\s*!important;/u,
  );
  assert.match(
    css,
    /data-font-scale="max"[^}]*grid-template-columns:\s*clamp\(340px, 24vw, 400px\) minmax\(0, 1fr\)\s*!important;/u,
  );
});

test("intermediate widths use the mobile sidebar without pushing chat below it", async () => {
  const css = await readFile(
    new URL("../public/synchron-vision.css", import.meta.url),
    "utf8",
  );

  assert.match(css, /@media \(max-width: 900px\)/u);
  assert.match(css, /\.app-shell > \.sidebar\s*\{[\s\S]*?display:\s*none;/u);
  assert.match(
    css,
    /\.app-shell > \.sidebar\.mobile-visible\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?display:\s*flex;/u,
  );
});

test("mobile chat content clears the measured composer and command bar", async () => {
  const [css, script, app] = await Promise.all([
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(css, /--sx-mobile-occupied-height/u);
  assert.match(css, /scroll-padding-bottom/u);
  assert.match(css, /#chatMessages::after/u);
  assert.match(script, /ResizeObserver/u);
  assert.match(script, /composerRect\.height/u);
  assert.match(script, /commandBarRect\.height/u);
  assert.match(script, /chatMessages\.scrollTop = chatMessages\.scrollHeight/u);
  assert.match(css, /user-select:\s*text/u);
  assert.match(app, /class="action-label">Копирай<\/span>/u);
});

test("the chat shows live autonomous task progress", async () => {
  const [script, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/synchron-vision.css", import.meta.url), "utf8"),
  ]);

  assert.match(script, /parsed\.event === "task"/u);
  assert.match(script, /updateTaskIndicator\(parsed\.data\)/u);
  assert.match(script, /Задачата е изпълнена и проверена/u);
  assert.match(css, /data-task-status="waiting_confirmation"/u);
});

test("the chat keeps a successful answer visible when conversation persistence fails", async () => {
  const [script, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(script, /conversationPersisted === false/u);
  assert.match(script, /warningCode === "CONVERSATION_NOT_SAVED"/u);
  assert.match(script, /Отговорът е получен, но разговорът не е запазен/u);
  assert.match(script, /showConversationPersistenceWarning\(responseBubble\)/u);
  assert.match(css, /\.conversation-persistence-warning/u);
});

test("each live AI answer shows its verified provider and model", async () => {
  const [script, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(script, /showAiResponseSource\(/u);
  assert.match(script, /parsed\.data\?\.provider/u);
  assert.match(script, /parsed\.data\?\.model/u);
  assert.match(script, /AI доставчик и модел/u);
  assert.match(css, /\.ai-response-source/u);
});

