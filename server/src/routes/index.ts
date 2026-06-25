import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import filesRouter from "./files.js";
import adminRouter from "./admin.js";
import gdriveAuthRouter from "./gdrive-auth.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(filesRouter);
router.use(adminRouter);
router.use(gdriveAuthRouter);

export default router;
