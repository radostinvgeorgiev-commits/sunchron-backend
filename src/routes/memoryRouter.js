import express from "express";
const router = express.Router();

router.get("/write", (req, res) => {
  res.json({ status: "ok", action: "memory.write", sample: true });
});

router.get("/get", (req, res) => {
  res.json({ status: "ok", action: "memory.get", key: "example" });
});

router.get("/list", (req, res) => {
  res.json({ status: "ok", action: "memory.list", items: [] });
});

export default router;
