import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { startStubServer } from "./ui/stub-server.mjs";

test("the stub server serves the real page and a streamed chat answer", async () => {
  const stub = await startStubServer();
  try {
    const page = await (await fetch(`${stub.origin}/`)).text();
    assert.match(page, /id="chatInput"/u);
    const reply = await (
      await fetch(`${stub.origin}/chat/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Здравей", model: "auto" }),
      })
    ).text();
    assert.match(reply, /event: done/u);
    assert.equal(stub.requests.at(-1).message, "Здравей");
    assert.equal((await fetch(`${stub.origin}/../package.json`)).status, 404);
  } finally {
    stub.server.close();
  }
});

test("the robot runs on pull requests and after the production smoke check", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ui-robot.yml", import.meta.url), "utf8");
  assert.match(workflow, /node tests\/ui\/robot\.mjs\n/u);
  assert.match(workflow, /robot\.mjs --public https:\/\/cloudaicore\.com/u);
  assert.match(workflow, /workflows: \["Production smoke check"\]/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

test("the / menu stays open when focus returns to the message box", () => {
  const tools = readFileSync(new URL("../public/prompt-tools.js", import.meta.url), "utf8");
  assert.match(tools, /if \(document\.activeElement !== input\) menu\.hidden = true;/u);
});
