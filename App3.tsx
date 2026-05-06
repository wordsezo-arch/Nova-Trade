import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { runMigrations } from "stripe-replit-sync";
import app from "./app";
import { logger } from "./lib/logger";
import { getStripeSync } from "./stripeClient";
import { SYMBOLS_CONFIG, BASE, liveBid, liveAsk, priceDp, priceSpread } from "./lib/prices";
import { startLivePriceFeed, onPriceUpdated } from "./lib/priceFeed";
import { loadSettings } from "./lib/settings";
import { startStopOutLoop } from "./lib/stopout";
import { startSLTPEngine }  from "./lib/sltpEngine";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

// ── Stripe init (non-blocking) ────────────────────────────────────────────────
async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  try {
    await runMigrations({ databaseUrl });
    const stripeSync = await getStripeSync();
    const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
    if (domain) await stripeSync.findOrCreateManagedWebhook(`https://${domain}/api/stripe/webhook`);
    stripeSync.syncBackfill().catch((err: unknown) => logger.error({ err }, "Stripe backfill error"));
    logger.info("Stripe initialized");
  } catch (err: unknown) {
    logger.warn({ err }, "Stripe initialization skipped (integration not yet connected)");
  }
}
void initStripe();

const server = http.createServer(app);

// ── Load persisted admin settings (commission, spreads, offsets) ──────────────
void loadSettings();

// ── Margin stop-out engine ────────────────────────────────────────────────────
startStopOutLoop();

// ── SL/TP execution engine ────────────────────────────────────────────────────
startSLTPEngine();

// ── Live price feed ───────────────────────────────────────────────────────────
startLivePriceFeed();

// ── WebSocket price broadcast ─────────────────────────────────────────────────
const prevBid: Record<string, number> = { ...liveBid };

function buildPayload(): string {
  const now     = new Date().toISOString();
  const payload = SYMBOLS_CONFIG.map(({ symbol, name }) => {
    const base = BASE[symbol];
    const dp   = priceDp(base);
    const prev = prevBid[symbol];
    const bid  = liveBid[symbol];
    const ask  = bid; // no spread — single mid-price

    prevBid[symbol] = bid;

    const change    = +(bid - base).toFixed(dp);
    const changePct = +(change / base * 100).toFixed(3);

    return {
      symbol, name, bid, ask,
      raw:      +base.toFixed(dp),   // unmodified price from data source (no offset)
      spread:   priceSpread[symbol] ?? 0,
      change,   changePct,
      prev,
      trending: bid > prev ? "up" : bid < prev ? "down" : "flat",
      high:     +(bid * 1.008).toFixed(dp),
      low:      +(bid * 0.991).toFixed(dp),
      timestamp: now,
    };
  });
  return JSON.stringify({ type: "prices", data: payload });
}

const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(): void {
  if (wss.clients.size === 0) return;
  const msg = buildPayload();
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on("connection", (ws) => {
  logger.info("WebSocket client connected");
  ws.send(buildPayload()); // send current prices immediately on connect
  ws.on("close", () => logger.info("WebSocket client disconnected"));
  ws.on("error", (err) => logger.error({ err }, "WebSocket error"));
});

// ── Push-on-change: broadcast the instant a price tick arrives ───────────────
// We keep a 16 ms throttle (one animation frame) so a burst of Binance ticks
// in the same millisecond is collapsed into one message, but we never delay
// longer than that — crucial for 0-gap sync with the TradingView chart widget.
let _pendingBroadcast: ReturnType<typeof setTimeout> | null = null;
const BROADCAST_THROTTLE_MS = 16;  // ≈ 1 animation frame

onPriceUpdated(() => {
  if (_pendingBroadcast !== null) return;          // already scheduled
  _pendingBroadcast = setTimeout(() => {
    _pendingBroadcast = null;
    broadcast();
  }, BROADCAST_THROTTLE_MS);
});

// Heartbeat: guarantees a broadcast even if the throttle window is missed.
setInterval(broadcast, 100);

server.listen(port, (err?: Error) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");
});
