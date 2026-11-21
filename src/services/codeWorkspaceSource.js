import { spawn } from "node:child_process";
import { extname } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
  getCodeWorkspaceBase,
  getCodeWorkspaceTree,
  getFileContent,
} from "./githubService.js";
import { isCodeWorkspaceSourceFile } from "./codexAgentService.js";

const MAX_REVIEW_FILE_BYTES = 100_000;

export async function loadCodeWorkspaceSource(repository, accessToken) {
  const readOptions = { accessToken };
  const baseSha = await getCodeWorkspaceBase(repository, readOptions);
  const tree = await getCodeWorkspaceTree(repository, baseSha, readOptions);
  const entries = new Map(tree.map((entry) => [entry.path, entry]));
  const contents = new Map();

  async function read(path) {
    if (!contents.has(path)) {
      contents.set(
        path,
        getFileContent(path, repository, baseSha, readOptions),
      );
    }
    return (await contents.get(path)).content;
  }

  return {
    baseSha,
    sourceFiles: tree
      .filter(
        ({ path, mode, size }) =>
          ["100644", "100755"].includes(mode) &&
          isCodeWorkspaceSourceFile(path, size),
      )
      .map(({ path, size }) => ({ path, bytes: size })),
    read,
    async original(path) {
      const parts = path.split("/");
      let ancestor = "";
      for (const part of parts.slice(0, -1)) {
        ancestor = ancestor ? `${ancestor}/${part}` : part;
        if (entries.has(ancestor) && entries.get(ancestor).type !== "tree") {
          throw new Error("Пътят пресича файл или връзка.");
        }
      }

      const entry = entries.get(path);
      if (!entry) return null;
      if (entry.mode !== "100644" || entry.size > MAX_REVIEW_FILE_BYTES) {
        throw new Error("Файлът изисква преглед извън работния екран.");
      }
      const content = await read(path);
      if (content.includes("\0") || Buffer.byteLength(content) !== entry.size) {
        throw new Error("Файлът не е обикновен UTF-8 текст.");
      }
      return content;
    },
  };
}

function nodeSyntaxCheck(content, type) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", `--input-type=${type}`], {
      env: {},
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === null) reject(new Error("Проверката прекъсна."));
      else resolve(code === 0);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(content);
  });
}

async function checkSyntax({ path, content }, jsType) {
  const extension = extname(path);
  if (extension === ".json") {
    try {
      JSON.parse(content);
      return { status: "passed", name: "JSON синтаксис" };
    } catch {
      return { status: "failed", name: "JSON синтаксис" };
    }
  }
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    const type = { ".js": jsType, ".mjs": "module", ".cjs": "commonjs" }[
      extension
    ];
    const valid = await nodeSyntaxCheck(content, type);
    return {
      status: valid ? "passed" : "failed",
      name: "JavaScript синтаксис",
    };
  }
  return {
    status: "skipped",
    name: "Няма автоматична проверка за този тип файл",
  };
}

export async function reviewCodeWorkspaceChanges(changes, source, originals) {
  const packageChange = changes.find(({ path }) => path === "package.json");
  const packageContent =
    packageChange?.content ?? (await source.original("package.json"));
  let jsType = "commonjs";
  try {
    if (JSON.parse(packageContent)?.type === "module") jsType = "module";
  } catch {
    // A proposed invalid package.json has its own failed check.
  }

  const reviews = [];
  for (const { path, content, reason } of changes) {
    const original = originals.get(path);
    if (original === content) continue;
    const diff = createTwoFilesPatch(
      original === null ? "/dev/null" : `a/${path}`,
      `b/${path}`,
      original ?? "",
      content,
      undefined,
      undefined,
      { timeout: 1_000 },
    );
    if (!diff)
      throw new Error(
        "Промяната не може да бъде показана в рамките на прегледа.",
      );
    reviews.push({
      path,
      reason,
      diff,
      check: await checkSyntax({ path, content }, jsType),
    });
  }
  return reviews;
}
