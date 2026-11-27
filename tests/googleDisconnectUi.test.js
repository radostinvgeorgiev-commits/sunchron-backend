import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const drawerScript = await readFile(new URL("../public/google-drive.js", import.meta.url), "utf8");

// The "Моят Google" drawer with a connected account; `disconnect` answers the
// button press.
async function openDrawer(disconnect) {
  const dom = new JSDOM(
    `<aside id="sidebar"></aside>
     <button id="googleDriveBtn"></button>
     <div id="drawerBackdrop" hidden></div>
     <section id="dataDrawer" hidden><h2 id="dataDrawerTitle"></h2><div id="dataDrawerBody"></div></section>`,
    { url: "https://cloudaicore.com/", runScripts: "outside-only" },
  );
  const { window } = dom;
  let connected = true;
  window.fetch = async (path) => {
    if (path === "/api/google/status") return Response.json({ connected, canRestore: false });
    if (path === "/api/google/files") return Response.json({ files: [] });
    if (path === "/api/google/disconnect") {
      const { status, body } = disconnect();
      if (status === 200) connected = false;
      return Response.json(body, { status });
    }
    return Response.json({}, { status: 404 });
  };
  window.eval(drawerScript);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  window.document.getElementById("googleDriveBtn").click();
  await settle();
  window.document.getElementById("disconnectGoogleDrive").click();
  await settle();
  return dom;
}

test("a failed disconnect says so and keeps the button to try again", async () => {
  const dom = await openDrawer(() => ({
    status: 503,
    body: { error: "Връзката с Google не се прекъсна. Опитай отново.", code: "GOOGLE_DISCONNECT_FAILED" },
  }));
  const body = dom.window.document.getElementById("dataDrawerBody");
  assert.match(body.querySelector(".drawer-error")?.textContent || "", /не се прекъсна/u);
  const button = dom.window.document.getElementById("disconnectGoogleDrive");
  assert.ok(button, "Прекъсни връзката is still there");
  assert.equal(button.disabled, false);
  dom.window.close();
});

test("a disconnect that worked shows Connect Google and no error", async () => {
  const dom = await openDrawer(() => ({ status: 200, body: { connected: false } }));
  const body = dom.window.document.getElementById("dataDrawerBody");
  assert.equal(body.querySelector(".drawer-error"), null);
  assert.ok(dom.window.document.getElementById("connectGoogleDrive"));
  assert.equal(dom.window.document.getElementById("disconnectGoogleDrive"), null);
  dom.window.close();
});
