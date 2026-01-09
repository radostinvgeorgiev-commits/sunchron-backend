import express from "express";

const router = express.Router();

const responseCache = new Map(); // Simple in-memory cache

router.post("/chat", async (req, res) => {
  const AGENT_URL = process.env.AGENT_URL || "https://a4ppevqrxnzlo6t2bgcpaj3a.agents.do-ai.run";
  const AGENT_KEY = process.env.AGENT_KEY;
  
  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof sessionId !== "string" || !sessionId.trim() || !message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "sessionId and message are required and must be non-empty strings." });
  }
  if (!AGENT_URL || !AGENT_KEY) {
    return res.status(500).json({ error: "Agent configuration missing." });
  }
  console.log(`[POST /chat] sessionId: ${sessionId}`);

  // Check Cache
  const cacheKey = message.trim().toLowerCase();
  if (responseCache.has(cacheKey)) {
      console.log(`[Cache] Hit for: "${cacheKey}"`);
      return res.json({ reply: responseCache.get(cacheKey), sessionId });
  }

  // --- Logic Core Check ---
  try {
    const LOGIC_CORE_URL = process.env.LOGIC_CORE_URL || "http://127.0.0.1:8000";
    // Simple command extraction for testing
    const command = message.trim().toLowerCase() === "destroy" ? "destroy" : "chat";
    
    const startLogic = Date.now();
    const decisionRes = await fetch(`${LOGIC_CORE_URL}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        command,
        payload: { message }
      }),
      signal: AbortSignal.timeout(2000) // Timeout after 2s if logic core is slow/down
    });
    const logicDuration = Date.now() - startLogic;
    console.log(`[LogicCore] Decision took ${logicDuration}ms`);

    if (decisionRes.ok) {
        const decision = await decisionRes.json();
        if (decision.allowed === false) {
            console.log(`[LogicCore] Denied: ${decision.reason}`);
            return res.json({ 
                reply: `⛔ Logic Core Refusal: ${decision.reason || "Operation not permitted."}`,
                sessionId
            });
        }
    }
  } catch (error) {
      console.warn("[LogicCore] Integration skipped (service unreachable/slow):", error.message);
      // Fail-open: Proceed if Logic Core is down (dev mode)
  }
  // ------------------------

  try {
    // Send to Agent (no database persistence)
    let reply = "(no reply)";
    try {
      const agentEndpoint = `${AGENT_URL}/api/v1/chat/completions`;
      const agentRes = await fetch(agentEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${AGENT_KEY}`
        },
        body: JSON.stringify({ 
          messages: [
            { role: "user", content: message }
          ]
        })
      });
      if (!agentRes.ok) {
        const errText = await agentRes.text();
        throw new Error(`Agent error: ${agentRes.status} ${errText}`);
      }
      const agentData = await agentRes.json();
      reply = agentData.choices?.[0]?.message?.content || agentData.reply || agentData.response || agentData.text || "(no reply)";
      console.log(`[Agent] Success for sessionId: ${sessionId}`);
    } catch (agentErr) {
      console.error(`[Agent] Failure for sessionId: ${sessionId}:`, agentErr?.message || agentErr);
      return res.status(502).json({ error: "Agent request failed." });
    }

    // Cache valid response
    if (responseCache.size > 100) {
        const firstKey = responseCache.keys().next().value; // Remove oldest
        responseCache.delete(firstKey);
    }
    responseCache.set(cacheKey, reply);

    res.json({ reply, sessionId });
  } catch (err) {
    console.error(`[POST /chat] Error for sessionId: ${sessionId}:`, err?.message || err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

export default router;
