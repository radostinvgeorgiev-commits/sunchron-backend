// Reads a personal archive (.zip from Facebook "Download your information",
// Google Takeout, or the data export of ChatGPT or Claude) inside the
// browser. Only the person's own texts are kept; other people's messages
// never leave the device.
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
// Years of AI chats make one big conversations.json; it is read once.
const MAX_CHAT_EXPORT_BYTES = 250 * 1024 * 1024;
export const ARCHIVE_TEXT_LIMIT = 190_000;

function readUint64(view, offset) {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
}

// The list of files in a .zip, read from its end without loading the whole
// archive into memory.
export async function listZipEntries(blob) {
  const tailSize = Math.min(blob.size, 65_557 + 20);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i -= 1) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Файлът не е .zip архив.");
  let count = tail.getUint16(eocd + 10, true);
  let size = tail.getUint32(eocd + 12, true);
  let offset = tail.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.getUint32(locator, true) !== 0x07064b50) throw new Error("Архивът не може да се прочете.");
    const z64Offset = readUint64(tail, locator + 8);
    const z64 = new DataView(await blob.slice(z64Offset, z64Offset + 56).arrayBuffer());
    count = readUint64(z64, 32);
    size = readUint64(z64, 40);
    offset = readUint64(z64, 48);
  }
  const directory = new DataView(await blob.slice(offset, offset + size).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = [];
  let at = 0;
  for (let i = 0; i < count && at + 46 <= directory.byteLength; i += 1) {
    if (directory.getUint32(at, true) !== 0x02014b50) break;
    const method = directory.getUint16(at + 10, true);
    let compressedSize = directory.getUint32(at + 20, true);
    let uncompressedSize = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    let localOffset = directory.getUint32(at + 42, true);
    const name = decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength));
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = readUint64(directory, field); field += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = readUint64(directory, field); field += 8; }
        if (localOffset === 0xffffffff) localOffset = readUint64(directory, field);
      }
      extra += 4 + length;
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    at = extraEnd + commentLength;
  }
  return entries;
}

export async function readZipText(blob, entry, maxBytes = MAX_ENTRY_BYTES) {
  if (entry.uncompressedSize > maxBytes) return "";
  const header = new DataView(await blob.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (header.getUint32(0, true) !== 0x04034b50) return "";
  const start = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const data = blob.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(await data.arrayBuffer());
  if (entry.method !== 8) return "";
  const stream = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

// Facebook writes UTF-8 bytes as separate \u00XX characters; turn them back.
export function fixFacebookText(value) {
  const text = String(value || "");
  if (!/[À-ÿ][\u0080-¿]/u.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

const day = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "");
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
// Newest first, cut to the size "Моите файлове" accepts.
function packLines(lines) {
  const sorted = lines.filter((line) => line.text.trim()).sort((a, b) => (b.at || 0) - (a.at || 0));
  const out = [];
  let used = 0;
  for (const line of sorted) {
    const row = `${line.label ? `${line.label} — ` : ""}${line.text.trim()}`;
    if (used + row.length + 2 > ARCHIVE_TEXT_LIMIT) break;
    out.push(row);
    used += row.length + 2;
  }
  return out.join("\n\n");
}

export function extractFacebook(files) {
  const posts = [];
  const comments = [];
  const ownMessages = [];
  let ownerName = "";
  for (const [name, text] of files) {
    if (/profile_information\/profile_information\.json$/u.test(name)) {
      const profile = parse(text);
      ownerName = fixFacebookText(profile?.profile_v2?.name?.full_name || profile?.profile?.name?.full_name || "");
    }
  }
  for (const [name, text] of files) {
    if (/\/posts\/your_posts[^/]*\.json$/u.test(name)) {
      for (const post of [].concat(parse(text) || [])) {
        const body = (post?.data || []).map((item) => fixFacebookText(item?.post || "")).filter(Boolean).join(" ");
        if (body) posts.push({ at: post.timestamp, label: day(post.timestamp), text: body });
      }
    } else if (/comments_and_reactions\/comments[^/]*\.json$/u.test(name)) {
      const data = parse(text);
      for (const item of data?.comments_v2 || data?.comments || []) {
        const body = (item?.data || []).map((entry) => fixFacebookText(entry?.comment?.comment || "")).filter(Boolean).join(" ");
        if (body) comments.push({ at: item.timestamp, label: day(item.timestamp), text: body });
      }
    } else if (ownerName && /\/messages\/(inbox|archived_threads|e2ee_cutover)\/[^/]+\/message_\d+\.json$/u.test(name)) {
      for (const message of parse(text)?.messages || []) {
        // Only what the person wrote; other people's words stay on the device.
        if (fixFacebookText(message?.sender_name) !== ownerName || !message?.content) continue;
        ownMessages.push({ at: (message.timestamp_ms || 0) / 1000, label: day((message.timestamp_ms || 0) / 1000), text: fixFacebookText(message.content) });
      }
    }
  }
  return [
    { name: "Facebook: моите публикации", text: packLines(posts) },
    { name: "Facebook: моите коментари", text: packLines(comments) },
    { name: "Facebook: какво съм писал в чатове", text: packLines(ownMessages) },
  ].filter(({ text }) => text.length >= 20);
}

export function extractTakeout(files) {
  const notes = [];
  const events = [];
  for (const [name, text] of files) {
    if (/(^|\/)Keep\/[^/]+\.json$/u.test(name)) {
      const note = parse(text);
      if (!note || note.isTrashed) continue;
      const items = (note.listContent || []).map((item) => `${item.isChecked ? "☑" : "☐"} ${item.text}`).join("\n");
      const body = [note.title, note.textContent, items].filter(Boolean).join("\n");
      const at = (note.userEditedTimestampUsec || 0) / 1e6;
      if (body.trim()) notes.push({ at, label: day(at), text: body });
    } else if (/(^|\/)Calendar\/.+\.ics$/u.test(name)) {
      for (const block of text.split("BEGIN:VEVENT").slice(1)) {
        const field = (key) => new RegExp(`^${key}[^:\\r\\n]*:(.*)$`, "mu").exec(block)?.[1]?.trim() || "";
        const summary = field("SUMMARY").replace(/\\([,;n])/gu, (_, c) => (c === "n" ? " " : c));
        const start = field("DTSTART");
        const date = /^(\d{4})(\d{2})(\d{2})/u.exec(start);
        const at = date ? Date.UTC(+date[1], +date[2] - 1, +date[3]) / 1000 : 0;
        if (summary) events.push({ at, label: date ? `${date[1]}-${date[2]}-${date[3]}` : "", text: summary });
      }
    }
  }
  return [
    { name: "Google Keep: моите бележки", text: packLines(notes) },
    { name: "Google Календар: моите събития", text: packLines(events) },
  ].filter(({ text }) => text.length >= 20);
}

const isoSeconds = (value) => {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms / 1000 : 0;
};
const titled = (title, text) => (title ? `[${String(title).trim()}] ${text}` : text);

// ChatGPT and Claude exports: only what the person wrote, never the AI's
// answers, so the avatar learns how the person thinks and what they asked.
export function extractAiChats(files) {
  const chatgpt = [];
  const claude = [];
  const claudeMemory = [];
  for (const [name, text] of files) {
    if (/(^|\/)memories\.json$/u.test(name)) {
      for (const item of [].concat(parse(text) || [])) {
        const memory = typeof item?.conversations_memory === "string" ? item.conversations_memory : "";
        if (memory.trim()) claudeMemory.push({ at: 0, label: "", text: memory });
      }
      continue;
    }
    if (!/(^|\/)conversations(-\d+)?\.json$/u.test(name)) continue;
    const data = parse(text);
    if (!Array.isArray(data)) continue;
    for (const chat of data) {
      if (chat?.mapping && typeof chat.mapping === "object") {
        for (const node of Object.values(chat.mapping)) {
          const message = node?.message;
          if (message?.author?.role !== "user") continue;
          const body = (message.content?.parts || []).filter((part) => typeof part === "string").join("\n").trim();
          if (!body) continue;
          const at = message.create_time || chat.create_time || 0;
          chatgpt.push({ at, label: day(at), text: titled(chat.title, body) });
        }
      } else if (Array.isArray(chat?.chat_messages)) {
        for (const message of chat.chat_messages) {
          if (message?.sender !== "human") continue;
          const parts = Array.isArray(message.content)
            ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text)
            : [];
          const body = (parts.join("\n") || message.text || "").trim();
          if (!body) continue;
          const at = isoSeconds(message.created_at || chat.created_at);
          claude.push({ at, label: day(at), text: titled(chat.name, body) });
        }
      }
    }
  }
  return [
    { name: "ChatGPT: какво съм писал", text: packLines(chatgpt) },
    { name: "Claude: какво съм писал", text: packLines(claude) },
    { name: "Claude: какво е запомнил за мен", text: packLines(claudeMemory) },
  ].filter(({ text }) => text.length >= 20);
}

const CHAT_EXPORTS = [/(^|\/)conversations(-\d+)?\.json$/u, /(^|\/)memories\.json$/u];

const WANTED = [
  ...CHAT_EXPORTS,
  /profile_information\/profile_information\.json$/u,
  /\/posts\/your_posts[^/]*\.json$/u,
  /comments_and_reactions\/comments[^/]*\.json$/u,
  /\/messages\/(inbox|archived_threads|e2ee_cutover)\/[^/]+\/message_\d+\.json$/u,
  /(^|\/)Keep\/[^/]+\.json$/u,
  /(^|\/)Calendar\/.+\.ics$/u,
];

// The whole flow: list, read only the files that matter, extract own texts.
export async function readPersonalArchive(blob, onProgress = () => {}) {
  const entries = (await listZipEntries(blob)).filter(({ name }) => WANTED.some((pattern) => pattern.test(name)));
  const files = [];
  for (const [index, entry] of entries.entries()) {
    onProgress(index + 1, entries.length);
    const big = CHAT_EXPORTS.some((pattern) => pattern.test(entry.name));
    const text = await readZipText(blob, entry, big ? MAX_CHAT_EXPORT_BYTES : MAX_ENTRY_BYTES);
    if (text) files.push([entry.name, text]);
  }
  const results = [...extractFacebook(files), ...extractTakeout(files), ...extractAiChats(files)];
  if (!results.length) {
    const html = entries.length === 0;
    throw new Error(
      html
        ? "Не намерих текстове в архива. За Facebook избери формат JSON при изтеглянето; за Google — Keep или Календар; за ChatGPT и Claude — архива от „Изнеси данните“."
        : "В архива няма твои текстове, които да се добавят.",
    );
  }
  return results;
}

if (typeof globalThis.window !== "undefined") {
  globalThis.AiCoreArchive = { readPersonalArchive };
  document.dispatchEvent(new CustomEvent("aicore:archive-ready"));
}
