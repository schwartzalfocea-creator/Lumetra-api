import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";

const app = express();

// ✅ CORS CONFIGURADO CORRECTAMENTE
app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://lumetra-frontend-dylizr6i3-schwartzalfocea-creators-projects.vercel.app"
  ],
  credentials: true,
}));

app.use(
  pinoHttp({
    logger,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

export default app;