import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createDatabase } from "../src/db.js";
import { hashPassword, passwordProblem } from '../src/security.js';

const db = createDatabase();

try {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );

  const migrationsUrl = new URL("../migrations/", import.meta.url);
  const migrationFiles = (await fs.readdir(migrationsUrl))
    .filter((name) => /^\d+_.*\.sql$/.test(name) && !name.includes("_seed_"))
    .sort();
  for (const version of migrationFiles) {
    const sql = await fs.readFile(new URL(version, migrationsUrl), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const appliedNow = await db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`attendesk-migration:${version}`]);
      const applied = await client.query("SELECT checksum FROM schema_migrations WHERE version=$1", [version]);
      if (applied.rowCount) {
        if (applied.rows[0].checksum !== checksum) throw new Error(`Applied migration ${version} has changed; create a new migration instead`);
        return false;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [version, checksum]);
      return true;
    });
    if (appliedNow) console.log(`Applied ${version}`);
  }

  if (process.env.SEED_DEMO === "true") {
    const seed = await fs.readFile(new URL("../migrations/002_seed_demo.sql", import.meta.url), "utf8");
    await db.query(seed);
  }

  const domain = String(process.env.COLLEGE_EMAIL_DOMAIN || "").trim().toLowerCase();
  const college = String(process.env.COLLEGE_NAME || "").trim();
  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (domain && college && adminEmail) {
    const initialPassword = process.env.ADMIN_PASSWORD;
    if (initialPassword && passwordProblem(initialPassword)) throw new Error(passwordProblem(initialPassword));
    const organization = await db.query(
      `INSERT INTO organizations(name,email_domain,timezone,attendance_threshold)
       VALUES($1,$2,$3,$4) ON CONFLICT(email_domain) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [college, domain, process.env.COLLEGE_TIMEZONE || "Asia/Kolkata", Number(process.env.ATTENDANCE_THRESHOLD || 75)]
    );
    await db.query(
      `INSERT INTO users(organization_id,email,full_name,role,status)
       VALUES($1,$2,$3,'admin','active') ON CONFLICT(organization_id,email) DO UPDATE SET role='admin',status='active'`,
      [organization.rows[0].id, adminEmail, process.env.ADMIN_NAME || "Main Administrator"]
    );
    if (initialPassword) {
      await db.query(`UPDATE users SET password_hash=$1,password_set_at=now(),username=COALESCE(username,$2)
        WHERE organization_id=$3 AND email=$4 AND password_hash IS NULL`,
        [hashPassword(initialPassword), process.env.ADMIN_USERNAME || adminEmail.split('@')[0], organization.rows[0].id, adminEmail]);
    }
  }
  console.log("Database migration completed");
} finally {
  await db.close();
}
