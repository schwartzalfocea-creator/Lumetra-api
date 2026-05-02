import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import app from "./app.js";
import pkg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pkg;

// 🔥 CONEXIÓN DEFINITIVA (DIRECTA + IPv4)
const pool = new Pool({
  host: "db.piiazllngkaduspmshnq.supabase.co",
  port: 5432,
  user: "postgres",
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
    console.error("🔥 ERROR:", err);

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