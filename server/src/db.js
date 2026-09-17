import pg from "pg";

const { Pool } = pg;

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE || 12),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" }
  });

  return {
    query: (text, params) => pool.query(text, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}
