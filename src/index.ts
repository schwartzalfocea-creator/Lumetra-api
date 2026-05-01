import app from "./app.js";
import pkg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const { Pool } = pkg;

// 🔥 CONEXIÓN CORRECTA (SIN connectionString)
const pool = new Pool({
  host: "aws-0-us-east-1.pooler.supabase.com",
  port: 6543,
  user: "postgres.piiazllngkaduspmshnq",
  password: "Bfo2rpUjm6Xa4Oyk",
  database: "postgres",
  ssl: {
    rejectUnauthorized: false,
  },
});

// TEST
app.get("/", (req, res) => {
  res.json({ message: "Lumetra funcionando 🚀" });
});

// REGISTER
app.post("/register", async (req, res) => {
  const { email, password } = req.body as any;

  try {
    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email y password requeridos",
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email",
      [email, hash]
    );

    res.json({ ok: true, user: result.rows[0] });
  } catch (err: any) {
    console.error("🔥 ERROR REAL:", err);

    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// START
const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log("🚀 Server running on port", port);
});