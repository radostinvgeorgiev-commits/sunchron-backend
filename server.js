import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import router from "./src/routes/index.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use("/", router);

mongoose
  .connect(process.env.MONGO_URL)
  .then(() => {
    console.log("🟢 MongoDB connected");
  })
  .catch((err) => {
    console.error("🔴 MongoDB connection error:", err);
  });

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

