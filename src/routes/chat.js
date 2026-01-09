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

    // Send to Agent (STREAMING MODE)
    // We will bypass the simple fetch(json) and implement streaming response
    try {
      const agentEndpoint = `${AGENT_URL}/api/v1/chat/completions`;
      
      const agentRes = await fetch(agentEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${AGENT_KEY}`
        },
        body: JSON.stringify({ 
          messages: payloadMessages,
          stream: true // Enable streaming
        })
      });

      if (!agentRes.ok) {
        throw new Error(`Agent error: ${agentRes.status}`);
      }

      // Configure response headers for streaming
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');

      let fullReply = "";
      const reader = agentRes.body.getReader();
      const decoder = new TextDecoder("utf-8");

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          // The Agent returns SSE format: data: {...}
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
               const jsonStr = line.slice(6).trim();
               if (jsonStr === '[DONE]') continue;
               try {
                   const data = JSON.parse(jsonStr);
                   const token = data.choices?.[0]?.delta?.content || "";
                   if (token) {
                       fullReply += token;
                       res.write(token); // Send to client immediately
                   }
               } catch (e) { /* ignore parse errors for partial chunks */ }
            }
          }
        }
      } catch (streamErr) {
          console.error("Stream reading error:", streamErr);
      } finally {
        res.end(); // End the response
      }
      
      console.log(`[Agent] Stream Success for sessionId: ${sessionId}`);
      
      // 4. Append Assistant Reply to history (After stream completes)
      if (fullReply.trim()) {
        history.push({ role: "assistant", content: fullReply });
        sessionHistory.set(sessionId, history);
        
        // Cache valid response
        if (responseCache.size > 100) {
            const firstKey = responseCache.keys().next().value; 
            responseCache.delete(firstKey);
        }
        responseCache.set(cacheKey, fullReply);
      }

      // Note: We already sent the response via res.write(), so no res.json() here.
      return; 

    } catch (agentErr) {
      console.error(`[Agent] Failure for sessionId: ${sessionId}:`, agentErr?.message || agentErr);
      return res.status(502).json({ error: "Agent request failed." });
    }
    // (Original non-streaming code removed)

  } catch (err) {
    console.error(`[POST /chat] Error for sessionId: ${sessionId}:`, err?.message || err);
    res.status(500).json({ error: err?.message || "Internal error" });
  }
});

export default router;
