import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import filesRouter from "./files.js";
import adminRouter from "./admin.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(filesRouter);
router.use(adminRouter);

export default router;
