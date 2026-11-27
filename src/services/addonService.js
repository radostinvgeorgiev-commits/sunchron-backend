import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import https from "node:https";
import { BlockList, isIP } from "node:net";

import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

// "Добавки": every person can write a small program of their own, try it in a
// closed sandbox and send it for review. Only what the owner approves becomes
// visible to everyone, and it stays a frozen copy of the reviewed code.
//
// Safety model:
// - The code runs inside QuickJS compiled to WebAssembly, in a fresh runtime
//   for every run, with a memory cap and a time cap. It has no network, no
//   files, no environment, no host objects: only `input`, `data` and `log`.
// - Data from outside comes from one https address the add-on declares. The
//   server fetches it without cookies or keys, only from public addresses
//   (checked on the resolved IP, so DNS tricks cannot reach internal hosts),
//   with no redirects, a short timeout and a size cap.
// - Drafts belong to their author. Public add-ons are reviewed snapshots.
export const ADDON_COLLECTION = "synchron-addons-v1";
export const ADDON_CATALOG_COLLECTION = "synchron-addons-catalog-v1";
export const ADDON_CATALOG_ID = "catalog";
export const ADDON_LIMITS = Object.freeze({
  perPerson: 20,
  name: 60,
  description: 300,
  code: 20000,
  url: 500,
  input: 4000,
  output: 8000,
  logLines: 20,
  pending: 50,
  public: 200,
  reviewNote: 300,
  instructions: 8000,
  claudeSkills: 5,
  claudeConnectors: 3,
  dataBytes: 200_000,
  fetchMs: 5000,
  runMs: 500,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
});

export class AddonError extends Error {
  constructor(message, status = 400, code = "ADDON_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const clean = (value, max) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max)
    : "";

// Code keeps its lines and indentation; only NUL-like characters go.
const cleanCode = (value) =>
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").replace(/\r\n?/gu, "\n") : "";

export function authorKey(ownerId) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new AddonError("Липсва профил.", 401, "ADDON_OWNER_REQUIRED");
  }
  return createHash("sha256").update(`addons:${ownerId}`).digest("hex").slice(0, 48);
}

// Addresses that must never be reached from the server.
const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (!family) return false;
  if (family === 4) return !blocked.check(address, "ipv4");
  // IPv4 written inside IPv6 (::ffff:…, ::a.b.c.d) is never a real public answer.
  if (/^(?:0*:)*:(?:ffff:)?(?:\d+\.|[0-9a-f]{1,4}:[0-9a-f]{1,4}$)/iu.test(address)) return false;
  return !blockedV6.check(address, "ipv6");
}

// The address an add-on reads from. `{input}` is replaced with what the
// person typed, URL-encoded.
export function checkDataUrl(value) {
  const text = clean(value, ADDON_LIMITS.url);
  if (!text) return "";
  let url;
  try {
    url = new URL(text.replaceAll("{input}", "x"));
  } catch {
    throw new AddonError("Адресът за данни не е валиден.");
  }
  if (url.protocol !== "https:") throw new AddonError("Адресът за данни трябва да започва с https://.");
  if (url.username || url.password) throw new AddonError("Адресът не може да съдържа потребител или парола.");
  if (url.port && url.port !== "443") throw new AddonError("Адресът трябва да е на стандартния порт.");
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isIP(host) || !host.includes(".") || /(^|\.)(localhost|local|internal|localdomain)$/u.test(host)) {
    throw new AddonError("Адресът трябва да е публичен сайт с име.");
  }
  if (text.includes("{input}") && url.hostname !== new URL(text.replaceAll("{input}", "y")).hostname) {
    throw new AddonError("Въведеното от човека не може да сменя сайта.");
  }
  return text;
}

export function fillDataUrl(template, input) {
  return template.replaceAll("{input}", encodeURIComponent(String(input || "")));
}

function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!list.length || list.some((item) => !isPublicAddress(item.address))) {
      return callback(new AddonError("Сайтът сочи към вътрешен адрес и е спрян.", 400, "ADDON_URL_BLOCKED"));
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

// Reads one public https address: no cookies, no keys, no redirects.
export function fetchPublicData(urlText, { timeoutMs = ADDON_LIMITS.fetchMs, maxBytes = ADDON_LIMITS.dataBytes, request = https.request } = {}) {
  const url = new URL(checkDataUrl(urlText));
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        timeout: timeoutMs,
        headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5", "user-agent": "AI-CORE-Addon/1" },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return reject(new AddonError("Сайтът пренасочва към друг адрес. Сложи крайния адрес.", 502, "ADDON_FETCH_REDIRECT"));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new AddonError(`Сайтът за данни отговори с грешка ${res.statusCode}.`, 502, "ADDON_FETCH_FAILED"));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new AddonError("Данните от сайта са твърде много (над 200 KB).", 502, "ADDON_FETCH_TOO_BIG"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (size > maxBytes) return;
          const body = Buffer.concat(chunks).toString("utf8");
          const type = String(res.headers["content-type"] || "");
          if (/json/iu.test(type) || /^\s*[[{]/u.test(body)) {
            try {
              return resolve(JSON.parse(body));
            } catch {
              // Not JSON after all: give the text.
            }
          }
          return resolve(body);
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new AddonError("Сайтът за данни не отговори навреме.", 504, "ADDON_FETCH_TIMEOUT")));
    req.on("error", (error) =>
      reject(error instanceof AddonError ? error : new AddonError("Сайтът за данни не може да се отвори.", 502, "ADDON_FETCH_FAILED")),
    );
    req.end();
  });
}

let quickJsModule;
async function loadQuickJs() {
  if (!quickJsModule) {
    const { getQuickJS } = await import("quickjs-emscripten");
    quickJsModule = await getQuickJS();
  }
  return quickJsModule;
}

// Runs the person's `run(input, data)` in a fresh closed sandbox.
export async function runInSandbox(code, { input = "", data = null, timeMs = ADDON_LIMITS.runMs } = {}) {
  const QuickJS = await loadQuickJs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(ADDON_LIMITS.memoryBytes);
  runtime.setMaxStackSize(ADDON_LIMITS.stackBytes);
  const deadline = Date.now() + timeMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  const logs = [];
  try {
    const log = vm.newFunction("log", (...args) => {
      if (logs.length < ADDON_LIMITS.logLines) {
        logs.push(args.map((handle) => String(vm.dump(handle))).join(" ").slice(0, 300));
      }
    });
    const consoleObject = vm.newObject();
    vm.setProp(consoleObject, "log", log);
    vm.setProp(vm.global, "console", consoleObject);
    vm.setProp(vm.global, "log", log);
    consoleObject.dispose();
    log.dispose();
    const args = vm.newString(JSON.stringify({ input: String(input).slice(0, ADDON_LIMITS.input), data }));
    vm.setProp(vm.global, "__novariumArgs", args);
    args.dispose();
    const source = [
      "(function () {",
      "  const { input, data } = JSON.parse(globalThis.__novariumArgs);",
      "  delete globalThis.__novariumArgs;",
      "  return (function () {",
      cleanCode(code),
      "  ;if (typeof run !== 'function') throw new Error('Липсва функция run(input, data).');",
      "  const result = run(input, data);",
      "  if (result && typeof result.then === 'function') throw new Error('run трябва да връща стойност веднага, без async.');",
      "  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);",
      "  })();",
      "})()",
    ].join("\n");
    const result = vm.evalCode(source, "addon.js");
    if (result.error) {
      const failure = vm.dump(result.error);
      result.error.dispose();
      const message =
        failure?.message === "interrupted"
          ? `Добавката работи твърде дълго (над ${timeMs} ms) и беше спряна.`
          : /out of memory/iu.test(String(failure?.message || failure))
            ? "Добавката използва твърде много памет и беше спряна."
            : `${failure?.name || "Грешка"}: ${failure?.message || String(failure)}`;
      return { ok: false, error: message.slice(0, 600), logs };
    }
    const value = vm.dump(result.value);
    result.value.dispose();
    return { ok: true, output: String(value ?? "").slice(0, ADDON_LIMITS.output), logs };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

// Three kinds of add-on:
// - "code": a small program run(input, data) in the closed sandbox;
// - "skill": written instructions Claude follows in "Работа с Claude";
// - "connector": a public MCP server address Claude may use there. Anthropic
//   connects to it from its own servers, never from ours, and with no keys.
export const ADDON_KINDS = Object.freeze(["code", "skill", "connector"]);
export const addonKind = (item) => (ADDON_KINDS.includes(item?.kind) ? item.kind : "code");

export function checkConnectorUrl(value) {
  const text = clean(value, ADDON_LIMITS.url);
  if (!text) throw new AddonError("Сложи адреса на конектора (MCP), напр. https://…/mcp.");
  if (text.includes("{input}")) throw new AddonError("Адресът на конектора не приема {input}.");
  return checkDataUrl(text);
}

// What the owner reviewed: a later change of any of these is a new version.
const contentOf = (item) =>
  JSON.stringify([addonKind(item), item.code || "", item.dataUrl || "", item.instructions || "", item.mcpUrl || ""]);

function normalizeDraft(input = {}) {
  const name = clean(input.name, ADDON_LIMITS.name);
  const description = clean(input.description, ADDON_LIMITS.description);
  const kind = addonKind(input);
  if (!name) throw new AddonError("Дай име на добавката.");
  if (kind === "skill") {
    const instructions = cleanCode(input.instructions).trim();
    if (!instructions) throw new AddonError("Напиши какво да прави Claude с това умение.");
    if (instructions.length > ADDON_LIMITS.instructions) throw new AddonError("Умението е твърде дълго (до 8000 знака).");
    return { kind, name, description, instructions };
  }
  if (kind === "connector") return { kind, name, description, mcpUrl: checkConnectorUrl(input.mcpUrl) };
  const code = cleanCode(input.code);
  if (!code.trim()) throw new AddonError("Напиши кода на добавката.");
  if (code.length > ADDON_LIMITS.code) throw new AddonError("Кодът е твърде дълъг (до 20 000 знака).");
  if (!/\brun\s*(?:=|\()/u.test(code)) throw new AddonError("Кодът трябва да има функция run(input, data).");
  return { kind, name, description, code, dataUrl: checkDataUrl(input.dataUrl) };
}

const publicView = (item) => ({
  id: item.id,
  kind: addonKind(item),
  name: item.name,
  description: item.description,
  code: item.code || "",
  dataUrl: item.dataUrl || "",
  instructions: item.instructions || "",
  mcpUrl: item.mcpUrl || "",
  approvedAt: item.approvedAt || null,
  updatedAt: item.updatedAt || null,
});

export function createAddonService({
  store,
  env = process.env,
  now = () => Date.now(),
  createId = randomUUID,
  fetchData = fetchPublicData,
  run = runInSandbox,
} = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));

  async function readMine(ownerId) {
    const row = await db().get(ADDON_COLLECTION, authorKey(ownerId));
    return Array.isArray(row?.data?.items) ? row.data.items : [];
  }
  async function readByKey(key) {
    const row = await db().get(ADDON_COLLECTION, key);
    return Array.isArray(row?.data?.items) ? row.data.items : [];
  }
  async function readCatalog() {
    const row = await db().get(ADDON_CATALOG_COLLECTION, ADDON_CATALOG_ID);
    return {
      pending: Array.isArray(row?.data?.pending) ? row.data.pending : [],
      public: Array.isArray(row?.data?.public) ? row.data.public : [],
    };
  }
  const setOp = (collection, id, data) => ({ type: "set", collection, id, data: { ...data, updatedAt: now() } });
  const catalogOp = (catalog) => setOp(ADDON_CATALOG_COLLECTION, ADDON_CATALOG_ID, catalog);
  const mineOp = (key, items) => setOp(ADDON_COLLECTION, key, { items });

  async function execute(addon, input) {
    if (addonKind(addon) !== "code") {
      return { ok: false, error: "Това е умение или конектор за Claude. Ползвай го в „Работа с Claude“.", logs: [] };
    }
    const text = String(input ?? "").slice(0, ADDON_LIMITS.input);
    let data = null;
    if (addon.dataUrl) {
      try {
        data = await fetchData(fillDataUrl(addon.dataUrl, text));
      } catch (error) {
        if (error instanceof AddonError) return { ok: false, error: error.message, logs: [] };
        throw error;
      }
    }
    return run(addon.code, { input: text, data });
  }

  async function save(ownerId, input = {}) {
    const key = authorKey(ownerId);
    const draft = normalizeDraft(input);
    const items = await readMine(ownerId);
    const index = input.id ? items.findIndex((item) => item.id === input.id) : -1;
    if (input.id && index < 0) throw new AddonError("Добавката не е намерена.", 404, "ADDON_NOT_FOUND");
    if (index < 0 && items.length >= ADDON_LIMITS.perPerson) {
      throw new AddonError("Имаш най-много 20 добавки. Изтрий някоя.", 409, "ADDON_LIMIT");
    }
    const previous = index >= 0 ? items[index] : null;
    const item = {
      id: previous?.id || createId(),
      ...draft,
      // A changed add-on is a new draft; the public copy stays as reviewed.
      status: "draft",
      published: Boolean(previous?.published),
      reviewNote: "",
      createdAt: previous?.createdAt || now(),
      updatedAt: now(),
    };
    const next = index >= 0 ? items.map((row, at) => (at === index ? item : row)) : [item, ...items];
    const operations = [mineOp(key, next)];
    if (previous?.status === "pending") {
      const catalog = await readCatalog();
      catalog.pending = catalog.pending.filter((row) => row.id !== item.id);
      operations.push(catalogOp(catalog));
    }
    await db().commitOperations(operations);
    return { item, items: next };
  }

  async function remove(ownerId, id) {
    const key = authorKey(ownerId);
    const items = await readMine(ownerId);
    if (!items.some((item) => item.id === id)) throw new AddonError("Добавката не е намерена.", 404, "ADDON_NOT_FOUND");
    const next = items.filter((item) => item.id !== id);
    const catalog = await readCatalog();
    catalog.pending = catalog.pending.filter((row) => row.id !== id);
    catalog.public = catalog.public.filter((row) => row.id !== id);
    await db().commitOperations([mineOp(key, next), catalogOp(catalog)]);
    return next;
  }

  async function submit(ownerId, id) {
    const key = authorKey(ownerId);
    const items = await readMine(ownerId);
    const item = items.find((row) => row.id === id);
    if (!item) throw new AddonError("Добавката не е намерена.", 404, "ADDON_NOT_FOUND");
    if (item.status === "public") throw new AddonError("Тази версия вече е одобрена.", 409, "ADDON_ALREADY_PUBLIC");
    const catalog = await readCatalog();
    catalog.pending = catalog.pending.filter((row) => row.id !== id);
    if (catalog.pending.length >= ADDON_LIMITS.pending) {
      throw new AddonError("Опашката за преглед е пълна. Опитай по-късно.", 429, "ADDON_QUEUE_FULL");
    }
    catalog.pending.push({
      id: item.id,
      authorKey: key,
      kind: addonKind(item),
      name: item.name,
      description: item.description,
      code: item.code || "",
      dataUrl: item.dataUrl || "",
      instructions: item.instructions || "",
      mcpUrl: item.mcpUrl || "",
      submittedAt: now(),
    });
    const next = items.map((row) => (row.id === id ? { ...row, status: "pending", reviewNote: "" } : row));
    await db().commitOperations([mineOp(key, next), catalogOp(catalog)]);
    return next;
  }

  async function review(id, { approve, note } = {}) {
    const catalog = await readCatalog();
    const entry = catalog.pending.find((row) => row.id === id);
    if (!entry) throw new AddonError("Няма такава добавка за преглед.", 404, "ADDON_NOT_PENDING");
    catalog.pending = catalog.pending.filter((row) => row.id !== id);
    const reviewNote = clean(note, ADDON_LIMITS.reviewNote);
    if (approve) {
      const others = catalog.public.filter((row) => row.id !== id);
      if (others.length >= ADDON_LIMITS.public) throw new AddonError("Магазинът е пълен.", 409, "ADDON_STORE_FULL");
      const { submittedAt: _submittedAt, ...snapshot } = entry;
      catalog.public = [{ ...snapshot, approvedAt: now(), updatedAt: now() }, ...others];
    }
    const items = await readByKey(entry.authorKey);
    // Only the version that was reviewed changes state; a newer draft stays.
    const next = items.map((row) =>
      row.id === id && row.status === "pending" && contentOf(row) === contentOf(entry)
        ? { ...row, status: approve ? "public" : "rejected", published: approve ? true : row.published, reviewNote }
        : row,
    );
    await db().commitOperations([mineOp(entry.authorKey, next), catalogOp(catalog)]);
    return { pending: catalog.pending };
  }

  async function unpublish(ownerId, id) {
    const key = authorKey(ownerId);
    const items = await readMine(ownerId);
    if (!items.some((row) => row.id === id)) throw new AddonError("Добавката не е намерена.", 404, "ADDON_NOT_FOUND");
    const catalog = await readCatalog();
    catalog.public = catalog.public.filter((row) => row.id !== id);
    catalog.pending = catalog.pending.filter((row) => row.id !== id);
    const next = items.map((row) => (row.id === id ? { ...row, status: "draft", published: false } : row));
    await db().commitOperations([mineOp(key, next), catalogOp(catalog)]);
    return next;
  }

  return {
    listMine: readMine,
    save,
    remove,
    submit,
    unpublish,
    async listPublic() {
      return (await readCatalog()).public.map(publicView);
    },
    // Only for the owner's review screen.
    async listPending() {
      return (await readCatalog()).pending.map((row) => ({ ...publicView(row), submittedAt: row.submittedAt }));
    },
    approve: (id, note) => review(id, { approve: true, note }),
    reject: (id, note) => review(id, { approve: false, note }),
    // Trying a draft that may not be saved yet: the author's own code only.
    async test(ownerId, input = {}) {
      authorKey(ownerId);
      const draft = normalizeDraft({ name: input.name || "проба", ...input });
      return execute(draft, input.input);
    },
    async runMine(ownerId, id, input) {
      const item = (await readMine(ownerId)).find((row) => row.id === id);
      if (!item) throw new AddonError("Добавката не е намерена.", 404, "ADDON_NOT_FOUND");
      return execute(item, input);
    },
    async runPublic(id, input) {
      const item = (await readCatalog()).public.find((row) => row.id === id);
      if (!item) throw new AddonError("Добавката не е намерена в магазина.", 404, "ADDON_NOT_FOUND");
      return execute(item, input);
    },
    // The owner can try a pending add-on before deciding.
    async runPending(id, input) {
      const item = (await readCatalog()).pending.find((row) => row.id === id);
      if (!item) throw new AddonError("Няма такава добавка за преглед.", 404, "ADDON_NOT_PENDING");
      return execute(item, input);
    },
    // "Работа с Claude": the skills and connectors a person picked, from their
    // own add-ons (any state) or from the store. Code add-ons are left out.
    async forClaude(ownerId, ids = []) {
      const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 20);
      if (!wanted.length) return { skills: [], connectors: [] };
      const mine = await readMine(ownerId);
      const store = (await readCatalog()).public;
      const pick = (id) => mine.find((row) => row.id === id) || store.find((row) => row.id === id);
      const chosen = wanted.map(pick).filter(Boolean);
      const skills = chosen.filter((row) => addonKind(row) === "skill");
      const connectors = chosen.filter((row) => addonKind(row) === "connector");
      if (skills.length > ADDON_LIMITS.claudeSkills) throw new AddonError("Избери до 5 умения наведнъж.");
      if (connectors.length > ADDON_LIMITS.claudeConnectors) throw new AddonError("Избери до 3 конектора наведнъж.");
      return {
        skills: skills.map((row) => ({ name: row.name, instructions: row.instructions })),
        connectors: connectors.map((row) => ({ name: row.name, url: row.mcpUrl })),
      };
    },
    // What the Claude tab can offer: own and store skills and connectors.
    async claudeChoices(ownerId) {
      const mine = await readMine(ownerId);
      const store = (await readCatalog()).public;
      const seen = new Set();
      const rows = [];
      for (const [row, own] of [...mine.map((row) => [row, true]), ...store.map((row) => [row, false])]) {
        if (addonKind(row) === "code" || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push({ id: row.id, kind: addonKind(row), name: row.name, description: row.description, own });
      }
      return rows;
    },
    // Account deletion: the person's add-ons and their store copies go.
    async clear(ownerId) {
      const key = authorKey(ownerId);
      const catalog = await readCatalog();
      const keep = (row) => row.authorKey !== key;
      const changed = catalog.pending.some((row) => !keep(row)) || catalog.public.some((row) => !keep(row));
      const operations = [{ type: "delete", collection: ADDON_COLLECTION, id: key }];
      if (changed) {
        operations.push(catalogOp({ pending: catalog.pending.filter(keep), public: catalog.public.filter(keep) }));
      }
      await db().commitOperations(operations);
    },
  };
}

let defaultService;
export function getAddonService() {
  return (defaultService ||= createAddonService());
}
