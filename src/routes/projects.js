import express from "express";
import { getOpenSearchClient } from "../config/opensearch.js";
import { logSafeError } from "../utils/safeLogging.js";

const router = express.Router();
const INDEX_NAME = "projects";

// GET /projects - List all projects
router.get("/", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    const response = await client.search({
      index: INDEX_NAME,
      body: {
        query: { match_all: {} }
      }
    });

    const projects = response.body.hits.hits.map(hit => ({
      id: hit._id,
      ...hit._source
    }));

    res.json(projects);
  } catch (error) {
    if (error.meta && error.meta.statusCode === 404) {
        return res.json([]);
    }
    logSafeError("[Projects] OpenSearch search failed", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// POST /projects - Create a new project
router.post("/", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    const project = {
      name: req.body.name,
      description: req.body.description,
      createdAt: new Date().toISOString(),
      status: req.body.status || "active"
    };

    const response = await client.index({
      index: INDEX_NAME,
      body: project,
      refresh: true
    });

    res.status(201).json({ id: response.body._id, ...project });
  } catch (error) {
    logSafeError("[Projects] OpenSearch index failed", error);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// GET /projects/:id - Get a single project
router.get("/:id", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    const response = await client.get({
      index: INDEX_NAME,
      id: req.params.id
    });

    res.json({ id: response.body._id, ...response.body._source });
  } catch (error) {
    if (error.meta && error.meta.statusCode === 404) {
      return res.status(404).json({ error: "Project not found" });
    }
    logSafeError("[Projects] OpenSearch get failed", error);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// DELETE /projects/:id - Delete a project
router.delete("/:id", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    await client.delete({
      index: INDEX_NAME,
      id: req.params.id,
      refresh: true
    });

    res.status(204).send();
  } catch (error) {
    if (error.meta && error.meta.statusCode === 404) {
      return res.status(404).json({ error: "Project not found" });
    }
    logSafeError("[Projects] OpenSearch delete failed", error);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

export default router;
