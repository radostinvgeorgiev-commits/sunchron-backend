import { createHash } from "node:crypto";

import { DEFAULT_CLAUDE_CHAT_MODEL } from "./novariumService.js";
import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

// "Работа с Claude": a person hands a bigger task to Claude, which works in
// Anthropic's closed container with its ready skills (presentation, Word,
// Excel, PDF), may search the web, and gives back text and finished files.
//
// - The container is Anthropic's, not ours: no access to our servers, keys or
//   the person's data. Only what the person typed goes in.
// - Files stay in Anthropic's file store. We keep a short list of which file
//   belongs to whom, so a person can download only their own files.
// - Members pay units for each task (reserved by the router); the owner not.
export const CLAUDE_WORK_COLLECTION = "synchron-claude-work-v1";
export const CLAUDE_WORK_LIMITS = Object.freeze({
  task: 8000,
  instructions: 20000,
  files: 30,
  continuations: 5,
  timeoutMs: 240_000,
  maxTokens: 16000,
  webSearches: 5,
  answer: 30000,
  fileBytes: 30 * 1024 * 1024,
});
// Anthropic's ready skills that run inside the container.
export const CLAUDE_WORK_SKILLS = Object.freeze({
  pptx: "Презентация (PowerPoint)",
  docx: "Документ (Word)",
  xlsx: "Таблица (Excel)",
  pdf: "PDF",
});
const API = "https://api.anthropic.com/v1";
const SYSTEM = [
  "Ти си Claude и работиш за човек в NovariumAI (cloudaicore.com) като помощник за по-големи задачи.",
  "Отговаряй на езика, на който е написана задачата. Пиши ясно и кратко, без технически жаргон.",
  "Когато правиш файл (презентация, документ, таблица, PDF, картинка, CSV), запиши готовия файл в папката $OUTPUT_DIR, за да може човекът да го изтегли. Давай на файла кратко ясно име.",
  "Не твърди, че си публикувал, изпратил или платил нещо: ти само подготвяш. Накрая кажи в едно изречение какво е готово и кои файлове има.",
].join("\n");

export class ClaudeWorkError extends Error {
  constructor(message, status = 400, code = "CLAUDE_WORK_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const clean = (value, max) =>
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim().slice(0, max) : "";

function ownerKey(ownerId) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new ClaudeWorkError("Липсва профил.", 401, "CLAUDE_WORK_OWNER_REQUIRED");
  }
  return createHash("sha256").update(`claude-work:${ownerId}`).digest("hex").slice(0, 48);
}

// Every file the container returned, wherever it sits in the answer.
export function collectFileIds(content) {
  const found = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.file_id === "string" && value.file_id) found.add(value.file_id);
    return Object.values(value).forEach(walk);
  };
  walk(content);
  return [...found];
}

export function answerText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("")
    .trim();
}

// A person's own skills (add-ons of kind "skill") become plain instructions.
export function skillInstructions(skills = []) {
  return skills
    .map((skill) => `## ${clean(skill.name, 60)}\n${clean(skill.instructions, 8000)}`)
    .join("\n\n")
    .slice(0, CLAUDE_WORK_LIMITS.instructions);
}

export function buildClaudeWorkRequest({
  model,
  task,
  skills = [],
  webSearch = false,
  instructions = "",
  connectors = [],
  containerId = "",
}) {
  const chosen = skills.filter((id) => Object.hasOwn(CLAUDE_WORK_SKILLS, id));
  const tools = [{ type: "code_execution_20260521", name: "code_execution" }];
  if (webSearch) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: CLAUDE_WORK_LIMITS.webSearches });
  // Connectors (MCP): Anthropic connects to them from its own servers.
  const mcpServers = connectors.slice(0, 3).map((connector, index) => ({ type: "url", url: connector.url, name: `connector-${index + 1}` }));
  for (const server of mcpServers) tools.push({ type: "mcp_toolset", mcp_server_name: server.name });
  const container = {
    ...(containerId ? { id: containerId } : {}),
    ...(chosen.length ? { skills: chosen.map((id) => ({ type: "anthropic", skill_id: id, version: "latest" })) } : {}),
  };
  return {
    model,
    max_tokens: CLAUDE_WORK_LIMITS.maxTokens,
    system: instructions ? `${SYSTEM}\n\nДопълнителни умения, които човекът е избрал:\n${instructions}` : SYSTEM,
    tools,
    ...(mcpServers.length ? { mcp_servers: mcpServers } : {}),
    ...(Object.keys(container).length ? { container } : {}),
  };
}

export const claudeWorkBetas = (body) =>
  ["code-execution-2025-08-25", ...(body.mcp_servers ? ["mcp-client-2025-11-20"] : [])].join(",");

async function describeError(response) {
  try {
    const body = await response.json();
    return `${String(body?.error?.type || "").slice(0, 60)}: ${String(body?.error?.message || "")
      .replace(/sk-ant-[A-Za-z0-9_-]+/gu, "[key]")
      .slice(0, 300)}`;
  } catch {
    return "";
  }
}

export function createClaudeWorkService({ store, env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));
  const apiKey = () => env.ANTHROPIC_API_KEY;
  const model = () => env.CLAUDE_WORK_MODEL || env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_CHAT_MODEL;
  const headers = (extra = {}) => ({ "x-api-key": apiKey(), "anthropic-version": "2023-06-01", ...extra });

  async function readFiles(ownerId) {
    const row = await db().get(CLAUDE_WORK_COLLECTION, ownerKey(ownerId));
    return Array.isArray(row?.data?.files) ? row.data.files : [];
  }

  async function fileInfo(id, signal) {
    const response = await fetchImpl(`${API}/files/${encodeURIComponent(id)}`, { headers: headers(), signal });
    if (!response.ok) return { id, name: "file", mimeType: "application/octet-stream", size: 0 };
    const data = await response.json();
    return {
      id,
      name: clean(String(data?.filename || "file").split(/[\\/]/u).pop(), 120) || "file",
      mimeType: clean(data?.mime_type, 120) || "application/octet-stream",
      size: Number(data?.size_bytes) || 0,
    };
  }

  async function run(ownerId, input = {}) {
    const key = ownerKey(ownerId);
    const task = clean(input.task, CLAUDE_WORK_LIMITS.task);
    if (!task) throw new ClaudeWorkError("Напиши задачата за Claude.");
    if (!apiKey()) throw new ClaudeWorkError("Claude не е конфигуриран.", 503, "CLAUDE_NOT_CONFIGURED");
    const skills = Array.isArray(input.skills) ? input.skills.map(String) : [];
    const instructions = clean(input.instructions, CLAUDE_WORK_LIMITS.instructions);
    const connectors = (Array.isArray(input.connectors) ? input.connectors : [])
      .filter((connector) => typeof connector?.url === "string" && connector.url.startsWith("https://"))
      .slice(0, 3);
    const signal = AbortSignal.timeout(CLAUDE_WORK_LIMITS.timeoutMs);
    const messages = [{ role: "user", content: task }];
    const content = [];
    let containerId = "";
    let usedModel = model();
    let stopReason = "";
    for (let step = 0; step <= CLAUDE_WORK_LIMITS.continuations; step++) {
      const body = {
        ...buildClaudeWorkRequest({ model: usedModel, task, skills, webSearch: Boolean(input.webSearch), instructions, connectors, containerId }),
        messages,
      };
      let response;
      try {
        response = await fetchImpl(`${API}/messages`, {
          method: "POST",
          headers: headers({ "Content-Type": "application/json", "anthropic-beta": claudeWorkBetas(body) }),
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          throw new ClaudeWorkError("Задачата отне твърде много време. Раздели я на по-малки части.", 504, "CLAUDE_WORK_TIMEOUT");
        }
        throw error;
      }
      if (!response.ok) {
        console.error(`[Claude work] Upstream request failed: ${response.status} ${await describeError(response)}`);
        throw new ClaudeWorkError(`Claude върна грешка ${response.status}. Опитай пак.`, 502, "CLAUDE_WORK_UPSTREAM");
      }
      const data = await response.json();
      usedModel = data?.model || usedModel;
      containerId = data?.container?.id || containerId;
      stopReason = data?.stop_reason || "";
      const blocks = Array.isArray(data?.content) ? data.content : [];
      content.push(...blocks);
      if (stopReason !== "pause_turn") break;
      // The server paused a long tool loop: send its turn back to go on.
      messages.push({ role: "assistant", content: blocks });
    }
    if (stopReason === "refusal") throw new ClaudeWorkError("Claude отказа тази задача.", 422, "CLAUDE_WORK_REFUSED");
    const fileIds = collectFileIds(content);
    const files = [];
    for (const id of fileIds.slice(0, 10)) files.push({ ...(await fileInfo(id, signal)), createdAt: now() });
    if (files.length) {
      const known = (await readFiles(ownerId)).filter((row) => !fileIds.includes(row.id));
      const kept = [...files, ...known].slice(0, CLAUDE_WORK_LIMITS.files);
      await db().commitOperations([
        { type: "set", collection: CLAUDE_WORK_COLLECTION, id: key, data: { files: kept, updatedAt: now() } },
      ]);
    }
    const text = answerText(content).slice(0, CLAUDE_WORK_LIMITS.answer);
    if (!text && !files.length) throw new ClaudeWorkError("Claude не върна резултат. Опитай пак.", 502, "CLAUDE_WORK_EMPTY");
    return {
      text,
      files: files.map(({ createdAt: _createdAt, ...file }) => file),
      model: usedModel,
      ...(stopReason === "max_tokens" || stopReason === "pause_turn" ? { unfinished: true } : {}),
    };
  }

  async function download(ownerId, fileId) {
    const file = (await readFiles(ownerId)).find((row) => row.id === fileId);
    if (!file) throw new ClaudeWorkError("Файлът не е намерен.", 404, "CLAUDE_WORK_FILE_NOT_FOUND");
    const response = await fetchImpl(`${API}/files/${encodeURIComponent(fileId)}/content`, {
      headers: headers(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new ClaudeWorkError("Файлът вече не е достъпен.", 410, "CLAUDE_WORK_FILE_GONE");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > CLAUDE_WORK_LIMITS.fileBytes) throw new ClaudeWorkError("Файлът е твърде голям.", 413, "CLAUDE_WORK_FILE_TOO_BIG");
    return { name: file.name, mimeType: file.mimeType, body };
  }

  return {
    skills: () => Object.entries(CLAUDE_WORK_SKILLS).map(([id, label]) => ({ id, label })),
    run,
    download,
    async listFiles(ownerId) {
      return (await readFiles(ownerId)).map(({ id, name, mimeType, size, createdAt }) => ({ id, name, mimeType, size, createdAt }));
    },
    // Account deletion: the files at Anthropic and the list go.
    async clear(ownerId) {
      const files = await readFiles(ownerId).catch(() => []);
      for (const file of files) {
        await fetchImpl(`${API}/files/${encodeURIComponent(file.id)}`, { method: "DELETE", headers: headers() }).catch(() => null);
      }
      await db().commitOperations([{ type: "delete", collection: CLAUDE_WORK_COLLECTION, id: ownerKey(ownerId) }]);
    },
  };
}

let defaultService;
export function getClaudeWorkService() {
  return (defaultService ||= createClaudeWorkService());
}
