import { Router } from "express";
import { getMetrics, getRecentRequests } from "../lib/repository";

const router = Router();

// 📊 métricas básicas
router.get("/admin/metrics", async (req, res, next) => {
  try {
    const metrics = await getMetrics();
    res.json(metrics);
  } catch (err) {
    next(err);
  }
});

// 📄 requests recientes
router.get("/admin/recent", async (req, res, next) => {
  try {
    const requests = await getRecentRequests(20);
    res.json(requests);
  } catch (err) {
    next(err);
  }
});

export default router;
