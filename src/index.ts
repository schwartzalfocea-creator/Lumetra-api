app.post("/login", async (req, res) => {
  const { email, password } = req.body as any;

  try {
    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email y password requeridos",
      });
    }

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

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(400).json({
        ok: false,
        error: "Password incorrecto",
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      "SECRET_KEY",
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