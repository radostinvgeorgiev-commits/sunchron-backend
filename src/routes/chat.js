import express from "express";

const router = express.Router();

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
  if (!AGENT_KEY) {
    return res.status(500).json({ error: "AGENT_KEY environment variable is required." });
  }
  if (!AGENT_URL) {
    return res.status(500).json({ error: "AGENT_URL environment variable is required." });
  }
  console.log(`[POST /chat] sessionId: ${sessionId}`);

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
    const payloadMessages = history;

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
        const upstreamErrorBody = await agentRes.text();
        console.error(
          `[Agent] Upstream error ${agentRes.status} ${agentRes.statusText}:`,
          upstreamErrorBody || "<empty response body>"
        );
        throw new Error(`Agent error: ${agentRes.status}`);
      }

      // Configure response headers for streaming
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');

      let fullReply = "";
      const reader = agentRes.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = ""; // Persistent buffer for incomplete SSE lines
      let streamCompleted = false; // Track if stream finished successfully

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          // The Agent returns SSE format: data: {...}
          sseBuffer += chunk;
          const lines = sseBuffer.split('\n');
          // Keep the last incomplete line in the buffer
          sseBuffer = lines.pop() || "";
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
               const jsonStr = line.slice(6).trim();
               if (!jsonStr || jsonStr === '[DONE]') continue;
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
        // Flush the TextDecoder after reader loop finishes
        sseBuffer += decoder.decode();
        
        // Process any remaining buffered line
        if (sseBuffer.startsWith('data: ')) {
          const jsonStr = sseBuffer.slice(6).trim();
          if (jsonStr && jsonStr !== '[DONE]') {
            try {
              const data = JSON.parse(jsonStr);
              const token = data.choices?.[0]?.delta?.content || "";
              if (token) {
                fullReply += token;
                res.write(token);
              }
            } catch (e) { /* ignore parse errors */ }
          }
        }
        
        streamCompleted = true;
        
        // End response after successful stream completion
        if (!res.writableEnded) {
          res.end();
        }
        
        console.log(`[Agent] Stream Success for sessionId: ${sessionId}`);
        
        // 4. Append Assistant Reply to history (After stream completes successfully)
        if (streamCompleted && fullReply.trim()) {
          history.push({ role: "assistant", content: fullReply });
          sessionHistory.set(sessionId, history);
        }
      } catch (streamErr) {
           console.error("Stream reading error:", streamErr);
           
           // If no response data has been sent, rethrow to allow the agentErr catch
           // to send a 502 JSON error response
           if (!res.headersSent) {
             throw streamErr;
           }
           
           // If streaming has already started, safely end the response and return
           // (cannot change HTTP status at this point)
           if (!res.writableEnded) {
             res.end();
           }
      }

      // Note: We already sent the response via res.write(), so no res.json() here.
      return; 

    } catch (agentErr) {
      // Only send error response if headers have not been sent yet
      if (!res.headersSent) {
        console.error(`[Agent] Failure for sessionId: ${sessionId}:`, agentErr?.message || agentErr);
        return res.status(502).json({ error: "Agent request failed." });
      } else {
        console.error(`[Agent] Failure for sessionId: ${sessionId}: ${agentErr?.message || agentErr} (streaming already started, cannot send error response)`);
        if (!res.writableEnded) {
          res.end();
        }
      }
    }
    // (Original non-streaming code removed)

  } catch (err) {
    // Only send error response if headers have not been sent
    if (!res.headersSent) {
      console.error(`[POST /chat] Error for sessionId: ${sessionId}:`, err?.message || err);
      res.status(500).json({ error: err?.message || "Internal error" });
    } else {
      console.error(`[POST /chat] Error for sessionId: ${sessionId}: ${err?.message || err} (streaming already started, cannot send error response)`);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
});

export default router;
