console.log("SERVER START OK 🔥");
console.log("ARCHIVO NUEVO CARGADO 🔥");

import app from "./app";
import { logger } from "./lib/logger";
import { sweepExpiredBatches } from "./lib/operations/confirmer";
import { Pool } from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

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
    console.error(err);

    if (err.code === "23505") {
      return res.status(400).json({
        ok: false,
        error: "El usuario ya existe",
      });
    }

    return res.status(500).json({
      ok: false,
      error: "Error creando usuario",
    });
  }
});

// ─────────────────────────────────────────────
// 🔥 LOGIN
// ─────────────────────────────────────────────
console.log("LOGIN ROUTE ACTIVA 🔥");

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
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      ok: false,
      error: "Error en login",
    });
  }
});

// ─────────────────────────────────────────────
// 🔐 MIDDLEWARE AUTH (EXPRESS)
// ─────────────────────────────────────────────
function authMiddleware(req: any, res: any, next: any) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "No token" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret"
    );

    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ─────────────────────────────────────────────
// 🔒 RUTA PROTEGIDA (CORRECTA)
// ─────────────────────────────────────────────
app.get("/me", authMiddleware, async (req: any, res) => {
  return res.json({
    ok: true,
    user: req.user,
  });
});

// ─────────────────────────────────────────────
// 🚀 START SERVER
// ─────────────────────────────────────────────
const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required");
}

const port = Number(rawPort);

app.listen(port, (err: any) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const SWEEP_INTERVAL_MS = 90_000;

  const runSweep = async () => {
    try {
      await sweepExpiredBatches();
    } catch (err) {
      logger.error({ err }, "background expiration sweep failed");
    }
  };

  void runSweep();
  setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);

  logger.info(
    { intervalMs: SWEEP_INTERVAL_MS },
    "background expiration sweep scheduled"
  );
});