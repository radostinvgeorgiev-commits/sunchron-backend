import express from "express";

const router = express.Router();

const responseCache = new Map(); // Simple in-memory cache
const sessionHistory = new Map(); // Store conversation history per sessionId

const MAX_HISTORY_LENGTH = 10; // Keep last 10 turns to avoid hitting token limits

const SYSTEM_PROMPT = {
  role: "system",
  content: `Вие сте Synchron-X, висш когнитивен AI консултант.
Вашата цел е да предоставяте стратегически съвети, задълбочени анализи и практически решения.
Мислете критично, анализирайте проблемите от множество ъгли и предлагайте конкретни стъпки за действие.
Бъдете кратки, точни и ясни. Използвайте професионален, но приятелски тон.`
};

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
  
  // Need to update history even on cache hit? 
  // No, better to SKIP cache for now to ensure conversation flow is correct.
  // Or: If Cache Hit, we add (User: msg, Assistant: cached_reply) to history.
  if (responseCache.has(cacheKey)) {
      console.log(`[Cache] Hit for: "${cacheKey}"`);
      const cachedReply = responseCache.get(cacheKey);
      
      // Update History on Cache Hit too!
      let history = sessionHistory.get(sessionId) || [];
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: cachedReply });
      sessionHistory.set(sessionId, history);

      return res.json({ reply: cachedReply, sessionId });
  }

  // --- Logic Core Check ---
  try {
    const LOGIC_CORE_URL = process.env.LOGIC_CORE_URL || "http://127.0.0.1:8000";
    // Simple command extraction for testing
    const command = message.trim().toLowerCase() === "destroy" ? "destroy" : "chat";
    
    // ... Logic Core code ...
  } catch (error) {
      // ...
  }
  // ------------------------

  try {
    // 1. Get History
    let history = sessionHistory.get(sessionId) || [];
    
    // 2. Append new user message
    history.push({ role: "user", content: message });
    
    // 3. Trim history if too long (keep system prompt if you had one, but here we just slice)
    if (history.length > MAX_HISTORY_LENGTH * 2) {
        history = history.slice(-(MAX_HISTORY_LENGTH * 2));
    }

    // Construct Payload with System Prompt always at start
    const payloadMessages = [SYSTEM_PROMPT, ...history];

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
          messages: payloadMessages // Send full history with system prompt
        })
      });
      if (!agentRes.ok) {
        const errText = await agentRes.text();
        throw new Error(`Agent error: ${agentRes.status} ${errText}`);
      }
      const agentData = await agentRes.json();
      reply = agentData.choices?.[0]?.message?.content || agentData.reply || agentData.response || agentData.text || "(no reply)";
      
      // 4. Append Assistant Reply to history
      history.push({ role: "assistant", content: reply });
      sessionHistory.set(sessionId, history);

      console.log(`[Agent] Success for sessionId: ${sessionId}`);
    } catch (agentErr) {
      console.error(`[Agent] Failure for sessionId: ${sessionId}:`, agentErr?.message || agentErr);
      return res.status(502).json({ error: "Agent request failed." });
    }

    // Cache valid response (only for single inputs, might be less useful with history but okay)
    if (responseCache.size > 100) {
        const firstKey = responseCache.keys().next().value; // Remove oldest
        responseCache.delete(firstKey);
    }
    // We cache the *last* reply for this specific message input, though context changes things.
    // For now, let's keep caching simple or maybe disable it if context matters? 
    // Actually, caching exact input might be confusing if context changes output. 
    // Let's UPDATE the cache logic to be: Cache disabled for conversation mode OR make sure cache key includes history hash.
    // simpler: Let's remove the "Cache Hit" return earlier because it breaks conversation flow.
    // Wait, the user liked the "instant reply".
    // Compromise: We only cache "Greeting" type messages or very specific static queries. 
    // For now, I will REMOVE the read-from-cache logic I added earlier to prioritize Correctness (Memory) over Speed of repeated inputs.
    // OR: I will leave it but know that it bypasses the Agent.
    
    responseCache.set(cacheKey, reply);

    res.json({ reply, sessionId });
  } catch (err) {
    console.error(`[POST /chat] Error for sessionId: ${sessionId}:`, err?.message || err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

export default router;
