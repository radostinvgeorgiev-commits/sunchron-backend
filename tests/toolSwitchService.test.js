import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import express from "express";
import request from "supertest";

import { createToolSwitchRouter } from "../src/routes/toolSwitchRouter.js";
import { createLocalDocumentStore } from "../src/services/localDocumentStore.js";
import {
  ToolSwitchError,
  TOOL_SWITCH_COLLECTION,
  capabilitiesOfTools,
  createToolSwitchService,
  switchableTools,
  toolOfGoogleAction,
  toolOfMcpName,
  toolSwitchDocumentId,
} from "../src/services/toolSwitchService.js";

// „Разкачи“ and „Свържи“ in „Инструменти“ (RADKO 28.11 13:50, 14:11): each
// person's own switches, for the tools their own account can use.
const OWNER = Object.freeze({ role: "owner", memoryOwnerId: "owner-a" });
const MEMBER = Object.freeze({ role: "member", memoryOwnerId: "member-b" });

const service = (store = createLocalDocumentStore()) => ({
  store,
  switches: createToolSwitchService({ store, now: () => 1_764_000_000_000 }),
});

test("a press changes only that person's own switch, and „Свържи“ turns it on again", async () => {
  const { switches } = service();
  await switches.set("owner-a", OWNER, "gmail-read", false);

  assert.deepEqual(await switches.toolsOff("owner-a"), ["gmail-read"]);
  assert.deepEqual(await switches.toolsOff("member-b"), []);
  assert.equal(await switches.stateOf("owner-a", "gmail-read"), "off");
  assert.equal(await switches.stateOf("member-b", "gmail-read"), "on");
  assert.equal(await switches.isOff("owner-a", "gmail-read"), true);

  const off = await switches.capabilitiesOff("owner-a");
  for (const capability of ["mail.read", "mail.search", "mail.send", "mail.delete"]) {
    assert.equal(off.has(capability), true, capability);
  }
  assert.equal(off.has("calendar.read"), false);
  assert.equal(off.unavailable, undefined);
  assert.equal((await switches.capabilitiesOff("member-b")).size, 0);

  const listed = await switches.set("owner-a", OWNER, "gmail-read", true);
  assert.equal(listed.tools.find((tool) => tool.id === "gmail-read").on, true);
  assert.deepEqual(await switches.toolsOff("owner-a"), []);
});

test("each person sees and switches only the tools their own account can use; the memory stays on", async () => {
  const { switches } = service();
  const memberTools = (await switches.list("member-b", MEMBER)).tools.map((tool) => tool.id);
  for (const id of ["gmail-read", "google-calendar-read", "google-contacts", "personal-todos", "openai-web-search"]) {
    assert.ok(memberTools.includes(id), id);
  }
  for (const id of ["github-write", "github-confirmed-write", "synchron-tasks", "google-cloud-write", "google-firestore-memory"]) {
    assert.equal(memberTools.includes(id), false, id);
  }
  const ownerTools = switchableTools(OWNER).map((tool) => tool.id);
  assert.ok(ownerTools.includes("github-write"));
  assert.equal(ownerTools.includes("google-firestore-memory"), false);

  await assert.rejects(
    () => switches.set("member-b", MEMBER, "github-write", false),
    (error) => error instanceof ToolSwitchError && error.status === 404 && error.code === "TOOL_SWITCH_NOT_FOUND",
  );
  await assert.rejects(
    () => switches.set("owner-a", OWNER, "google-firestore-memory", false),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () => switches.set("owner-a", OWNER, "gmail-read", "off"),
    (error) => error.status === 400 && error.code === "TOOL_SWITCH_INVALID",
  );
  // The memory is never switched off, even from a stored row.
  assert.equal(await switches.stateOf("owner-a", "google-firestore-memory"), "on");
});

test("the row is kept under a hash of the profile, never under the profile itself", () => {
  const id = toolSwitchDocumentId("owner-a");
  assert.match(id, /^[0-9a-f]{64}$/u);
  assert.notEqual(id, toolSwitchDocumentId("member-b"));
  assert.equal(id.includes("owner-a"), false);
  assert.throws(() => toolSwitchDocumentId(" "), (error) => error.status === 401);
});

test("two quick presses on two cards both stay", async () => {
  // Each read comes back late and each write waits, so both presses read
  // the same row before either writes.
  const local = createLocalDocumentStore();
  const slow = {
    ...local,
    async get(...args) {
      const row = await local.get(...args);
      await sleep(15);
      return row;
    },
    async set(...args) {
      await sleep(5);
      return local.set(...args);
    },
  };
  const { switches } = service(slow);
  await Promise.all([
    switches.set("owner-a", OWNER, "gmail-read", false),
    switches.set("owner-a", OWNER, "google-calendar-read", false),
  ]);
  assert.deepEqual((await switches.toolsOff("owner-a")).sort(), ["gmail-read", "google-calendar-read"]);

  // And again on a row that already exists.
  await Promise.all([
    switches.set("owner-a", OWNER, "gmail-read", true),
    switches.set("owner-a", OWNER, "google-contacts", false),
  ]);
  assert.deepEqual((await switches.toolsOff("owner-a")).sort(), ["google-calendar-read", "google-contacts"]);
});

test("a write that keeps failing says so and changes nothing", async () => {
  const local = createLocalDocumentStore();
  let writes = 0;
  const conflict = Object.assign(new Error("precondition"), { upstreamStatus: 400, upstreamErrorStatus: "FAILED_PRECONDITION" });
  const { switches } = service({
    ...local,
    async set() {
      writes += 1;
      throw conflict;
    },
  });
  await assert.rejects(
    () => switches.set("owner-a", OWNER, "gmail-read", false),
    (error) => error instanceof ToolSwitchError && error.status === 503 && /не беше записана/u.test(error.message),
  );
  assert.equal(writes, 5);

  const broken = service({ ...local, set: async () => Promise.reject(new Error("down")) });
  await assert.rejects(() => broken.switches.set("owner-a", OWNER, "gmail-read", false), (error) => error.status === 503);
});

test("when the switches cannot be read, every tool stays out and it is not called the person's choice", async () => {
  const { switches } = service({
    ...createLocalDocumentStore(),
    get: async () => Promise.reject(Object.assign(new Error("Firestore down"), { status: 503 })),
  });
  const off = await switches.capabilitiesOff("owner-a");
  assert.equal(off.unavailable, true);
  for (const capability of ["mail.send", "calendar.write", "todos.add", "code.write", "web.search"]) {
    assert.equal(off.has(capability), true, capability);
  }
  // The memory is not a switch: it stays usable.
  assert.equal(off.has("memory.read"), false);
  assert.equal(await switches.stateOf("owner-a", "gmail-read"), "unavailable");
  assert.equal(await switches.isOff("owner-a", "gmail-read"), true);
  assert.equal(await switches.stateOf("owner-a", "google-firestore-memory"), "on");
  await assert.rejects(() => switches.list("owner-a", OWNER), (error) => error instanceof ToolSwitchError && error.status === 503);

  // A row that is not there is no error: everything is on.
  const missing = service({
    ...createLocalDocumentStore(),
    get: async () => Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
  });
  assert.deepEqual(await missing.switches.toolsOff("owner-a"), []);
});

test("the switches go with the person's account", async () => {
  const { store, switches } = service();
  await switches.set("owner-a", OWNER, "gmail-read", false);
  await switches.set("member-b", MEMBER, "gmail-read", false);
  await switches.forget("owner-a");
  assert.equal(await store.get(TOOL_SWITCH_COLLECTION, toolSwitchDocumentId("owner-a")), null);
  assert.deepEqual(await switches.toolsOff("owner-a"), []);
  assert.deepEqual(await switches.toolsOff("member-b"), ["gmail-read"]);
  // Nothing to delete is fine.
  await switches.forget("nobody");
  const gone = service({
    ...createLocalDocumentStore(),
    delete: async () => Promise.reject(Object.assign(new Error("not found"), { status: 404 })),
  });
  await gone.switches.forget("owner-a");
});

test("each MCP tool and each confirmed Google step has its switch", () => {
  assert.equal(toolOfMcpName("confirm_calendar_event"), "google-calendar-write");
  assert.equal(toolOfMcpName("prepare_gmail_send"), "gmail-read");
  assert.equal(toolOfMcpName("talk_to_novarium"), "synchron-agent-chat");
  assert.equal(toolOfMcpName("get_personal_context"), null);
  assert.equal(toolOfMcpName("constructor"), null);
  assert.equal(toolOfGoogleAction("contacts.write:create"), "google-contacts");
  assert.equal(toolOfGoogleAction("contacts.write:update"), "google-contacts");
  assert.equal(toolOfGoogleAction("mail.send:message"), "gmail-read");
  assert.equal(toolOfGoogleAction("mail.delete:message"), "gmail-read");
  assert.equal(toolOfGoogleAction(""), "gmail-read");

  const calendar = capabilitiesOfTools(["google-calendar-write"]);
  assert.deepEqual([...calendar], ["calendar.write"]);
});

test("„Инструменти“ reads and changes the switches of the signed-in person only", async () => {
  const { switches } = service();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.owner = MEMBER;
    next();
  });
  app.use("/api/tools/switches", createToolSwitchRouter({ service: switches }));

  const listed = await request(app).get("/api/tools/switches").expect(200);
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.equal(listed.body.tools.find((tool) => tool.id === "gmail-read").on, true);

  const changed = await request(app).put("/api/tools/switches/gmail-read").send({ on: false }).expect(200);
  assert.equal(changed.body.tools.find((tool) => tool.id === "gmail-read").on, false);
  assert.deepEqual(await switches.toolsOff("member-b"), ["gmail-read"]);
  assert.deepEqual(await switches.toolsOff("owner-a"), []);

  const invalid = await request(app).put("/api/tools/switches/gmail-read").send({ on: "no" }).expect(400);
  assert.equal(invalid.body.code, "TOOL_SWITCH_INVALID");
  const notTheirs = await request(app).put("/api/tools/switches/github-write").send({ on: false }).expect(404);
  assert.equal(notTheirs.body.code, "TOOL_SWITCH_NOT_FOUND");
});
