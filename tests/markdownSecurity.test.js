import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";

const rendererSource = await readFile(
  new URL("../public/markdown-renderer.js", import.meta.url),
  "utf8",
);

function createRenderer() {
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(rendererSource, context);
  return context.SynchronMarkdown.renderSafeMarkdown;
}

function createHarness() {
  const dom = new JSDOM("<!doctype html><body></body>");
  return {
    dom,
    element: dom.window.document.createElement("div"),
    sanitizer: createDOMPurify(dom.window),
  };
}

function render(text, dependencies = {}) {
  const { dom, element, sanitizer } = createHarness();
  const result = createRenderer()(element, text, {
    markdownParser: marked,
    sanitizer,
    ...dependencies,
  });
  return { dom, element, result };
}

test("normal markdown keeps headings, lists, safe links, and code", () => {
  const { element, result } = render(
    [
      "## Заглавие",
      "",
      "- **Едно**",
      "- [Източник](https://example.com)",
      "",
      "`код`",
    ].join("\n"),
  );

  assert.equal(result.mode, "html");
  assert.equal(element.querySelector("h2")?.textContent, "Заглавие");
  assert.equal(element.querySelectorAll("li").length, 2);
  assert.equal(element.querySelector("strong")?.textContent, "Едно");
  assert.equal(
    element.querySelector("a")?.getAttribute("href"),
    "https://example.com",
  );
  assert.equal(element.querySelector("code")?.textContent, "код");
});

test("script elements are removed before insertion", () => {
  const { element } = render(
    "<script>globalThis.pwned = true</script>Безопасно",
  );

  assert.equal(element.querySelector("script"), null);
  assert.doesNotMatch(element.innerHTML, /globalThis\.pwned/u);
  assert.match(element.textContent, /Безопасно/u);
});

test("event handler attributes are removed from images", () => {
  const { element } = render('<img src="x" onerror="globalThis.pwned=true">');
  const image = element.querySelector("img");

  assert.ok(image);
  assert.equal(image.hasAttribute("onerror"), false);
});

test("javascript links are neutralized", () => {
  const { element } = render("[опасен линк](javascript:alert(1))");
  const link = element.querySelector("a");

  assert.ok(link);
  assert.equal(link.hasAttribute("href"), false);
});

test("iframes and inline styles are not allowed", () => {
  const { element } = render(
    '<iframe src="https://example.com"></iframe><p style="color:red">Текст</p>',
  );

  assert.equal(element.querySelector("iframe"), null);
  assert.equal(element.querySelector("p")?.hasAttribute("style"), false);
});

test("missing sanitizer falls back to textContent", () => {
  const { dom, element } = createHarness();
  const result = createRenderer()(element, "<img src=x onerror=alert(1)>", {
    markdownParser: marked,
    sanitizer: null,
  });

  assert.equal(result.mode, "text");
  assert.equal(element.querySelector("img"), null);
  assert.equal(element.textContent, "<img src=x onerror=alert(1)>");
  assert.match(element.innerHTML, /&lt;img/u);
  assert.equal(dom.window.globalThis.pwned, undefined);
});

test("sanitizer errors also fall back to textContent", () => {
  const { element } = createHarness();
  const result = createRenderer()(element, "<script>alert(1)</script>", {
    markdownParser: marked,
    sanitizer: {
      sanitize() {
        throw new Error("test sanitizer failure");
      },
    },
  });

  assert.equal(result.mode, "text");
  assert.equal(element.querySelector("script"), null);
  assert.equal(element.textContent, "<script>alert(1)</script>");
});
