import app from "./app.js";
import pkg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pkg;

// 🔥 CONEXIÓN FINAL DEFINITIVA (SUPABASE + POOLER + RAILWAY)
const pool = new Pool({
  connectionString: "postgresql://postgres.piiazllngkaduspmshnq:Bfo2rpUjm6Xa4Oyk@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
  ssl: {
    rejectUnauthorized: false,
  },
  max: 1,
  idleTimeoutMillis: 0,
  connectionTimeoutMillis: 10000,
});

// TEST
app.get("/", (req, res) => {
  res.json({ message: "Lumetra funcionando 🚀" });
});

// REGISTER
app.post("/register", async (req, res) => {
  const { email, password } = req.body as any;

  try {
    // Validación
    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email y password requeridos",
      });
    }

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // INSERT (compatible con PgBouncer)
    const result = await pool.query({
      text: `
        INSERT INTO users (email, password)
        VALUES ($1, $2)
        RETURNING id, email
      `,
      values: [email, hash],
    });

    res.json({
      ok: true,
      user: result.rows[0],
    });

  } catch (err: any) {
    console.error("🔥 ERROR REAL:", err);

    res.status(500).json({
      ok: false,
      error: err.message || err,
    });
  }
});

// START
const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log("🚀 Server running on port", port);
});