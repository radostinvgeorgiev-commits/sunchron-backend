import express from "express";
import { getOpenSearchClient } from "../config/opensearch.js";

const router = express.Router();
const INDEX_NAME = "projects";

// POST / - Create a new project
router.post("/", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    const projectData = req.body;
    if (!projectData || Object.keys(projectData).length === 0) {
      return res.status(400).json({ error: "Project data is required" });
    }

    // Create the document in OpenSearch
    const response = await client.index({
      index: INDEX_NAME,
      body: {
        ...projectData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      refresh: true,
    });

    res.status(201).json({
      status: "success",
      id: response.body._id,
      message: "Project created successfully",
    });
  } catch (error) {
    console.error("Error creating project:", error);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// GET / - List all projects
router.get("/", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    const response = await client.search({
      index: INDEX_NAME,
      body: {
        query: {
          match_all: {},
        },
      },
    });

    const projects = response.body.hits.hits.map((hit) => ({
      id: hit._id,
      ...hit._source,
    }));

    res.json({
      status: "success",
      count: projects.length,
      projects,
    });
  } catch (error) {
    if (error.meta?.body?.error?.type === "index_not_found_exception") {
      return res.json({
        status: "success",
        count: 0,
        projects: [],
      });
    }
    console.error("Error listing projects:", error);
    res.status(500).json({ error: "Failed to list projects" });
  }
});

// GET /:id - Get a project by ID
router.get("/:id", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    const { id } = req.params;

    const response = await client.get({
      index: INDEX_NAME,
      id: id,
    });

    res.json({
      status: "success",
      project: {
        id: response.body._id,
        ...response.body._source,
      },
    });
  } catch (error) {
    if (error.meta?.body?.found === false) {
      return res.status(404).json({ error: "Project not found" });
    }
    console.error("Error getting project:", error);
    res.status(500).json({ error: "Failed to get project" });
  }
});

// DELETE /:id - Delete a project by ID
router.delete("/:id", async (req, res) => {
  try {
    const client = getOpenSearchClient();
    if (!client) {
      return res.status(503).json({ error: "OpenSearch client not available" });
    }

    const { id } = req.params;

    await client.delete({
      index: INDEX_NAME,
      id: id,
      refresh: true,
    });

    res.json({
      status: "success",
      message: "Project deleted successfully",
    });
  } catch (error) {
    if (error.meta?.body?.result === "not_found") {
      return res.status(404).json({ error: "Project not found" });
    }
    console.error("Error deleting project:", error);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

export default router;
