import app from "./app";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

console.log("SERVER START OK 🔥");

// 🔥 CONEXIÓN A DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ─────────────────────────────────────────────
// 🔥 RUTA BASE
// ─────────────────────────────────────────────
app.get("/", async (req, res) => {
  return res.json({ message: "Lumetra funcionando 🚀" });
});

// ─────────────────────────────────────────────
// 🔥 REGISTER
// ─────────────────────────────────────────────
app.post("/register", async (req, res) => {
  const { email, password } = req.body as any;

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Email y password requeridos",
    });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email",
      [email, hashedPassword]
    );

    return res.json({
      ok: true,
      user: result.rows[0],
    });
  } catch (err: any) {
    console.error("ERROR REGISTER:", err);

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// 🔥 LOGIN
// ─────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { email, password } = req.body as any;

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Email y password requeridos",
    });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Usuario no encontrado",
      });
    }

    const user = result.rows[0];

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).json({
        ok: false,
        error: "Password incorrecta",
      });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || "dev_secret",
      { expiresIn: "1h" }
    );

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (err: any) {
    console.error("ERROR LOGIN:", err);

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// 🚀 START SERVER
// ─────────────────────────────────────────────
const port = Number(process.env.PORT || 8080);

app.listen(port, () => {
  console.log("Server listening on port", port);
});