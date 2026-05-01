import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";

const app = express();

app.use(
  pinoHttp({
    logger,
  })
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

export default app;