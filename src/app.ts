import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";

const app = express();

// 🔥 CORS SIMPLE (EL QUE FUNCIONA SIEMPRE)
app.use(cors({
  origin: "*"
}));

app.use(
  pinoHttp({
    logger,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

export default app;