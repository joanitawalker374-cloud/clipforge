import { Pool } from "pg";

// Un seul pool réutilisé entre les invocations (évite d'épuiser les connexions).
const globalForPg = global as unknown as { pgPool?: Pool };

export const pool =
  globalForPg.pgPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    max: 3,
  });

if (process.env.NODE_ENV !== "production") globalForPg.pgPool = pool;

export type JobType = "tiktok" | "caption" | "uniquify";

export async function createJob(
  type: JobType,
  params: Record<string, unknown>,
  inputKey?: string
) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (type, params, input_key, status)
     VALUES ($1, $2, $3, 'queued') RETURNING id`,
    [type, params, inputKey ?? null]
  );
  return rows[0].id as string;
}

export async function getJob(id: string) {
  const { rows } = await pool.query("SELECT * FROM jobs WHERE id=$1", [id]);
  return rows[0];
}
