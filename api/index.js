/**
 * Vercel serverless entrypoint.
 *
 * Vercel's zero-config Node runtime only turns files inside /api into
 * Functions. The previous release exported an Express app from the repository
 * root, which Vercel never picked up — that is why every path returned
 * 404 NOT_FOUND. vercel.json rewrites all traffic here.
 */
import express from "express";
import { createDatabase } from "../server/src/db.js";
import { createProductionApp } from "../server/src/production-app.js";

let handler;

export default function vercelHandler(req, res) {
  if (!handler) {
    const app = express();
    createProductionApp({ db: createDatabase(), app });
    handler = app;
  }
  return handler(req, res);
}
