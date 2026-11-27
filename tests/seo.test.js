import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../public/${path}`, import.meta.url), "utf8");

test("home page tells search engines and link previews it is AI CORE", async () => {
  const html = await read("index.html");
  assert.match(html, /<title>SYNCHRON-X · AI CORE[^<]*<\/title>/u);
  assert.match(html, /property="og:image" content="https:\/\/cloudaicore\.com\/og-image\.png"/u);
  assert.match(html, /name="twitter:card" content="summary_large_image"/u);
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/u);
  assert.ok(ld, "structured data present");
  assert.equal(JSON.parse(ld[1]).name, "AI CORE");
  const image = await stat(new URL("../public/og-image.png", import.meta.url));
  assert.ok(image.size > 1000);
});

test("sitemap lists every public page and llms.txt describes the product", async () => {
  const sitemap = await read("sitemap.xml");
  for (const page of ["", "plans", "help", "developers", "status", "privacy", "terms"]) {
    assert.match(sitemap, new RegExp(`<loc>https://cloudaicore\\.com/${page}</loc>`, "u"));
  }
  const llms = await read("llms.txt");
  assert.match(llms, /^# AI CORE/u);
  assert.match(llms, /https:\/\/cloudaicore\.com\/mcp/u);
});

test("IndexNow key file is served so Bing and Yandex accept update pings", async () => {
  assert.equal(await read("b1b8926aa2b2276601d0435a82d89360.txt"), "b1b8926aa2b2276601d0435a82d89360");
});

test("blog lists its articles, each linked from the sitemap", async () => {
  const index = await read("blog/index.html");
  const sitemap = await read("sitemap.xml");
  const links = [...index.matchAll(/href="\/blog\/([a-z0-9-]+\.html)"/gu)].map((m) => m[1]);
  assert.ok(links.length >= 2);
  for (const file of links) {
    const page = await read(`blog/${file}`);
    assert.match(page, /<h1>/u);
    assert.match(page, /"@type": ?"Article"/u);
    assert.match(sitemap, new RegExp(`/blog/${file.replace(".", "\\.")}<`, "u"));
  }
  assert.match(await read("index.html"), /href="\/blog\/"/u);
});
