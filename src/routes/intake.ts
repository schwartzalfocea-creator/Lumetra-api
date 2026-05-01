import { Router, type IRouter } from "express";
import { processIntake } from "../lib/intake";

const router: IRouter = Router();

router.post("/intake", async (req, res, next) => {
  try {
    const body = req.body as {
      text?: unknown;
      input?: unknown;
      source?: unknown;
      to_phone?: unknown;
      to_email?: unknown;
      from_name?: unknown;
    };
    const candidate = body?.text ?? body?.input;

    if (typeof candidate !== "string") {
      res.status(400).json({
        error: "INVALID_PAYLOAD",
        message: "Request body must include a string `text` (or `input`) field.",
      });
      return;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      res.status(400).json({ error: "EMPTY_INPUT", message: "`text` must be non-empty." });
      return;
    }

    if (trimmed.length > 4000) {
      res.status(413).json({ error: "INPUT_TOO_LARGE", message: "`text` must be ≤4000 characters." });
      return;
    }

    const source = typeof body?.source === "string" ? body.source : "web";
    const toPhone = typeof body?.to_phone === "string" ? body.to_phone : undefined;
    const toEmail = typeof body?.to_email === "string" ? body.to_email : undefined;
    const fromName = typeof body?.from_name === "string" ? body.from_name : undefined;

    const result = await processIntake({ text: trimmed, source, toPhone, toEmail, fromName });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
