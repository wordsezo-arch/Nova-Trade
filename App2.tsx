import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import marketRouter from "./market";
import walletRouter from "./wallet";
import tradesRouter from "./trades";
import transactionsRouter from "./transactions";
import adminRouter from "./admin";
import stripeRouter from "./stripe";
import kycRouter    from "./kyc";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(marketRouter);
router.use(walletRouter);
router.use(tradesRouter);
router.use(transactionsRouter);
router.use(adminRouter);
router.use(stripeRouter);
router.use(kycRouter);

export default router;
