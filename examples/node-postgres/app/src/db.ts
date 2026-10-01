import pg from "pg";

/** One pool per process; DATABASE_URL comes from docker-compose.yml. */
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

export async function ready(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
