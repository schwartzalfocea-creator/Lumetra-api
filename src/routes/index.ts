import { Router, type IRouter } from "express";
import healthRouter from "./health";
import analyzeRouter from "./analyze";
import intakeRouter from "./intake";
import adminRouter from "./admin";
import authRouter from "./auth";
import queueRouter from "./queue";
import webhookRouter from "./webhook";
import integrationsRouter from "./integrations";
import operationsRouter from "./operations";
import { ledgerRouter } from "./ledger";
import confirmationsRouter from "./confirmations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(analyzeRouter);
router.use(intakeRouter);
router.use(adminRouter);
router.use(authRouter);
router.use(queueRouter);
router.use(webhookRouter);
router.use(integrationsRouter);
router.use(operationsRouter);
router.use(ledgerRouter);
router.use(confirmationsRouter);
export default router;
