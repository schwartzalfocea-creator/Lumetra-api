import express from "express";
import pkg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const { Pool } = pkg;

const app = express();
app.use(express.json());

// 🔐 SECRET (después lo movemos a .env)
const JWT_SECRET = "SECRET_KEY";

// ✅ CONEXIÓN DB
const pool = new Pool({
  connectionString: "postgresql://postgres.piiazllngkaduspmshnq:Bfo2rpUjm6Xa4Oyk@aws-1-us-east-1.pooler.supabase.com:6543/postgres",
  ssl: {
    rejectUnauthorized: false,
  },
  max: 1,
});


// 🔐 MIDDLEWARE AUTH
const auth = (req, res, next) => {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({
        ok: false,
        error: "No token",
      });
    }

    const token = header.split(" ")[1];

    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "Token inválido",
    });
  }
};


// TEST
app.get("/", (req, res) => {
  res.json({ message: "Lumetra funcionando 🚀" });
});


// REGISTER
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email y password requeridos",
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "El usuario ya existe",
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password)
       VALUES ($1, $2)
       RETURNING id, email`,
      [email, hash]
    );

    res.json({
      ok: true,
      user: result.rows[0],
    });

  } catch (err: any) {
    console.error("🔥 REGISTER ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message || err,
    });
  }
});


// LOGIN
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Usuario no encontrado",
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(400).json({
        ok: false,
        error: "Password incorrecto",
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
      },
    });

  } catch (err: any) {
    console.error("🔥 LOGIN ERROR:", err);

    res.status(500).json({
      ok: false,
      error: err.message || err,
    });
  }
});


// 🔒 RUTA PROTEGIDA
app.get("/me", auth, (req, res) => {
  res.json({
    ok: true,
    user: req.user,
  });
});


// START
const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log("🚀 Server running on port", port);
});