import express from "express";

const router = express.Router();

const sessionHistory = new Map();
const MAX_HISTORY_LENGTH = 10;
const HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_AGENT_TIMEOUT_MS = 360000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractTokenFromAgentEvent(rawEvent) {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) return { type: "ignore" };

  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return { type: "done" };

  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new Error("Invalid JSON event received from the AI agent.");
  }

  const token = data.choices?.[0]?.delta?.content;
  return typeof token === "string" && token
    ? { type: "token", token }
    : { type: "ignore" };
}

router.post("/chat", async (req, res) => {
  const agentUrl =
    process.env.AGENT_URL ||
    "https://a4ppevqrxnzlo6t2bgcpaj3a.agents.do-ai.run";
  const agentKey = process.env.AGENT_KEY;
  const agentTimeoutMs = parsePositiveInteger(
    process.env.AGENT_TIMEOUT_MS,
    DEFAULT_AGENT_TIMEOUT_MS,
  );

  const { sessionId, message } = req.body || {};
  if (
    !sessionId ||
    typeof sessionId !== "string" ||
    !sessionId.trim() ||
    !message ||
    typeof message !== "string" ||
    !message.trim()
  ) {
    return res.status(400).json({
      error: "sessionId and message are required and must be non-empty strings.",
    });
  }

  if (!agentKey) {
    return res
      .status(500)
      .json({ error: "AGENT_KEY environment variable is required." });
  }

  console.log(`[POST /chat] sessionId: ${sessionId}`);

  const previousHistory = sessionHistory.get(sessionId) || [];
  let history = [...previousHistory, { role: "user", content: message.trim() }];
  if (history.length > MAX_HISTORY_LENGTH * 2) {
    history = history.slice(-(MAX_HISTORY_LENGTH * 2));
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const sendEvent = (event, data) => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  const sendHeartbeat = () => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }
  };

  const abortController = new AbortController();
  let timedOut = false;
  let heartbeatInterval;
  let timeoutHandle;

  const cleanup = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  };

  const abortUpstream = () => {
    if (!abortController.signal.aborted) abortController.abort();
  };

  res.on("close", () => {
    cleanup();
    if (!res.writableEnded) abortUpstream();
  });

  sendHeartbeat();
  heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortUpstream();
  }, agentTimeoutMs);

  try {
    const agentEndpoint = `${agentUrl}/api/v1/chat/completions`;
    const agentRes = await fetch(agentEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({
        messages: history,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!agentRes.ok) {
      const upstreamErrorBody = await agentRes.text();
      console.error(
        `[Agent] Upstream error ${agentRes.status} ${agentRes.statusText}:`,
        upstreamErrorBody || "<empty response body>",
      );
      sendEvent("error", {
        status: agentRes.status,
        message: `AI агентът върна грешка ${agentRes.status}. Опитайте отново.`,
      });
      return;
    }

    if (!agentRes.body) {
      throw new Error("AI agent returned an empty response stream.");
    }

    const reader = agentRes.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let upstreamBuffer = "";
    let fullReply = "";

    const processBufferedEvents = (flush = false) => {
      upstreamBuffer = upstreamBuffer.replace(/\r\n/g, "\n");
      const events = upstreamBuffer.split("\n\n");
      upstreamBuffer = flush ? "" : events.pop() || "";

      if (flush && events.length === 0 && upstreamBuffer) {
        events.push(upstreamBuffer);
        upstreamBuffer = "";
      }

      for (const rawEvent of events) {
        if (!rawEvent.trim()) continue;
        const parsed = extractTokenFromAgentEvent(rawEvent);
        if (parsed.type === "token") {
          fullReply += parsed.token;
          if (!sendEvent("token", { token: parsed.token })) {
            abortUpstream();
            return false;
          }
        }
      }

      return true;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      upstreamBuffer += decoder.decode(value, { stream: true });
      if (!processBufferedEvents()) return;
    }

    upstreamBuffer += decoder.decode();
    if (upstreamBuffer.trim()) {
      const parsed = extractTokenFromAgentEvent(
        upstreamBuffer.replace(/\r\n/g, "\n"),
      );
      if (parsed.type === "token") {
        fullReply += parsed.token;
        sendEvent("token", { token: parsed.token });
      }
    }

    if (!fullReply.trim()) {
      throw new Error("AI agent completed without returning text.");
    }

    history.push({ role: "assistant", content: fullReply });
    sessionHistory.set(sessionId, history);
    sendEvent("done", { ok: true });
    console.log(`[Agent] Stream Success for sessionId: ${sessionId}`);
  } catch (error) {
    if (abortController.signal.aborted && !timedOut) {
      console.log(`[Agent] Request cancelled for sessionId: ${sessionId}`);
      return;
    }

    const message = timedOut
      ? `AI агентът не отговори в рамките на ${Math.round(
          agentTimeoutMs / 1000,
        )} секунди. Опитайте отново.`
      : "Връзката с AI агента беше прекъсната. Опитайте отново.";

    console.error(
      `[Agent] Failure for sessionId: ${sessionId}:`,
      error?.message || error,
    );
    sendEvent("error", { status: timedOut ? 504 : 502, message });
  } finally {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

export default router;
