import express from "express";
import { createDatabase } from "./server/src/db.js";
import { createProductionApp } from "./server/src/production-app.js";

const database = createDatabase();
const app = express();

// Vercel detects this root Express export and turns it into one Function.
// The same application factory is used by the long-running Docker server.
createProductionApp({ db: database, app });

export default app;
