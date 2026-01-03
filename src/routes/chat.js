import express from "express";
const router = express.Router();

router.post("/", async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({
      status: "error",
      message: "Message is required"
    });
  }
  
  try {
    // Placeholder for chat functionality
    res.json({
      status: "ok",
      message: "Chat endpoint",
      echo: message,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

export default router;
