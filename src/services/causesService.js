import { createHash, randomUUID } from "node:crypto";

import { createFirestoreDocumentStore } from "./firestoreDocumentStore.js";

// "Каузи": anyone with an account can propose a social cause, and people show
// with a like where they would want the money to go. This is only the list and
// the votes — no money is collected or moved here.
export const CAUSES_COLLECTION = "synchron-causes-v1";
const BOARD_ID = "board";
export const CAUSE_LIMITS = Object.freeze({ items: 100, title: 90, description: 800, perAuthor: 5 });

export class CausesError extends Error {
  constructor(message, status = 400, code = "CAUSE_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const clean = (value, max) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").replace(/\s+/gu, " ").trim().slice(0, max)
    : "";

function personKey(ownerId) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new CausesError("Липсва профил.", 401, "CAUSE_OWNER_REQUIRED");
  }
  return createHash("sha256").update(`cause:${ownerId}`).digest("hex").slice(0, 24);
}

export function createCausesService({ store, env = process.env, now = () => Date.now() } = {}) {
  let runtimeStore = store;
  const db = () => (runtimeStore ||= createFirestoreDocumentStore({ env }));

  const view = (causes, me, isOwner) =>
    causes
      .filter((cause) => !cause.hidden || isOwner)
      .map((cause) => ({
        id: cause.id,
        title: cause.title,
        description: cause.description,
        author: cause.authorName,
        createdAt: cause.createdAt,
        likes: cause.likes.length,
        liked: cause.likes.includes(me),
        mine: cause.authorKey === me,
        hidden: Boolean(cause.hidden),
      }))
      .sort((a, b) => b.likes - a.likes || b.createdAt - a.createdAt);

  // Read, change and write the board; retry when someone else wrote first.
  async function change(identity, mutate) {
    const me = personKey(identity?.memoryOwnerId);
    const isOwner = identity?.role === "owner";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await db().get(CAUSES_COLLECTION, BOARD_ID, { includeMetadata: true });
      const causes = (row?.data?.causes || []).map((cause) => ({ ...cause, likes: [...(cause.likes || [])] }));
      const next = mutate(causes, me, isOwner);
      try {
        await db().commitOperations([
          {
            type: "set",
            collection: CAUSES_COLLECTION,
            id: BOARD_ID,
            data: { causes: next, updatedAt: now() },
            ...(row?.updateTime ? { updateTime: row.updateTime } : { createOnly: true }),
          },
        ]);
        return view(next, me, isOwner);
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    return [];
  }
  const find = (causes, id) => {
    const cause = causes.find((item) => item.id === id);
    if (!cause) throw new CausesError("Каузата не е намерена.", 404, "CAUSE_NOT_FOUND");
    return cause;
  };

  async function list(identity) {
    const me = personKey(identity?.memoryOwnerId);
    const row = await db().get(CAUSES_COLLECTION, BOARD_ID);
    return view(
      (row?.data?.causes || []).map((cause) => ({ ...cause, likes: cause.likes || [] })),
      me,
      identity?.role === "owner",
    );
  }
  async function propose(identity, value) {
    const title = clean(value?.title, CAUSE_LIMITS.title);
    const description = clean(value?.description, CAUSE_LIMITS.description);
    if (title.length < 4 || description.length < 10) {
      throw new CausesError("Напиши име и кратко описание на каузата.");
    }
    return change(identity, (causes, me) => {
      if (causes.length >= CAUSE_LIMITS.items) {
        throw new CausesError("Списъкът с каузи е пълен.", 409, "CAUSE_LIST_FULL");
      }
      if (causes.filter((cause) => cause.authorKey === me).length >= CAUSE_LIMITS.perAuthor) {
        throw new CausesError("Вече имаш пет предложени каузи.", 409, "CAUSE_AUTHOR_LIMIT");
      }
      return [
        ...causes,
        {
          id: randomUUID(),
          title,
          description,
          authorKey: me,
          authorName: clean(identity?.displayName, 40) || "Потребител",
          createdAt: now(),
          likes: [me],
          hidden: false,
        },
      ];
    });
  }
  async function like(identity, id, on = true) {
    return change(identity, (causes, me) => {
      const cause = find(causes, id);
      cause.likes = cause.likes.filter((key) => key !== me);
      if (on) cause.likes.push(me);
      return causes;
    });
  }
  // The author can remove their own cause; the owner can hide or show any.
  async function remove(identity, id) {
    return change(identity, (causes, me, isOwner) => {
      const cause = find(causes, id);
      if (cause.authorKey === me) return causes.filter((item) => item.id !== id);
      if (!isOwner) throw new CausesError("Това не е твоя кауза.", 403, "CAUSE_FORBIDDEN");
      cause.hidden = !cause.hidden;
      return causes;
    });
  }
  return { list, propose, like, remove };
}

let defaultService;
export function getCausesService() {
  return (defaultService ||= createCausesService());
}
