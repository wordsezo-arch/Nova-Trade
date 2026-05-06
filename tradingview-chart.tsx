/**
 * TradingView Advanced Chart embed.
 *
 * Price sync strategy (zero-gap):
 * ─────────────────────────────────────────────────────────────────────────────
 * The free TradingView widget (tv.js) communicates with its iframe via
 * window.postMessage. Every price tick the iframe receives from TradingView's
 * own WebSocket is forwarded to the parent page in the TradingView wire
 * protocol format (~m~N~m~{JSON}) and occasionally as plain JSON objects.
 *
 * We install a window "message" listener that parses BOTH formats and fires
 * the `onPriceTick` callback with (ourSymbol, rawPrice) the instant the
 * widget renders the new price — same moment the chart updates, zero gap.
 *
 * Position lines are drawn in two ways:
 *  1. createShape() on the TradingView widget — works if the free widget
 *     supports it (best-effort, silently skipped if unavailable).
 *  2. A CSS/SVG overlay rendered on top of the chart — guaranteed to show,
 *     uses a rolling price buffer to track the visible Y-axis range.
 */
import { useEffect, useRef, useState } from "react";

// ── Public types ──────────────────────────────────────────────────────────────

export interface PositionLine {
  price:      number;
  color:      string;
  label:      string;
  lineStyle?: 0 | 1 | 2;
  lineWidth?: number;
}

// ── Symbol mappings ───────────────────────────────────────────────────────────

const TV_SYMBOLS: Record<string, string> = {
  XAUUSD: "TVC:GOLD",
  XAGUSD: "TVC:SILVER",
  US30:   "TVC:DJI",
  BTCUSD: "BITSTAMP:BTCUSD",
  ETHUSD: "BITSTAMP:ETHUSD",
  EURUSD: "FX:EURUSD",
  GBPUSD: "FX:GBPUSD",
  USDJPY: "FX:USDJPY",
};

const TV_SYMBOLS_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(TV_SYMBOLS).map(([k, v]) => [v, k]),
);

/**
 * Typical half-range visible on a 15-minute chart.
 * Used as fallback before the rolling price buffer fills up.
 */
const SYMBOL_HALF_RANGE: Record<string, number> = {
  XAUUSD: 60,
  XAGUSD: 2.5,
  BTCUSD: 6000,
  ETHUSD: 250,
  US30:   600,
  EURUSD: 0.010,
  GBPUSD: 0.010,
  USDJPY: 2.0,
};

// ── Script loader (singleton) ─────────────────────────────────────────────────

type ScriptStatus = "idle" | "loading" | "loaded" | "error";
let scriptStatus: ScriptStatus = "idle";
const pendingCallbacks: Array<() => void> = [];

function whenTvReady(cb: () => void) {
  if (scriptStatus === "loaded") { cb(); return; }
  pendingCallbacks.push(cb);
  if (scriptStatus !== "idle") return;
  scriptStatus = "loading";
  const s = document.createElement("script");
  s.src     = "https://s3.tradingview.com/tv.js";
  s.async   = true;
  s.onload  = () => { scriptStatus = "loaded"; pendingCallbacks.splice(0).forEach(fn => fn()); };
  s.onerror = () => { scriptStatus = "error";  pendingCallbacks.splice(0); };
  document.head.appendChild(s);
}

// ── TradingView wire-protocol parser ──────────────────────────────────────────

function parseTvWirePackets(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const header = text.substring(i).match(/^~m~(\d+)~m~/);
    if (!header) break;
    const skip = header[0].length;
    const len  = parseInt(header[1], 10);
    out.push(text.substring(i + skip, i + skip + len));
    i += skip + len;
  }
  return out;
}

// ── Chart API helpers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TvWidget = any;

function safeChart(w: TvWidget) {
  try { return w?.activeChart?.() ?? w?.chart?.() ?? null; } catch { return null; }
}

function clearShapes(widget: TvWidget, ids: string[]): void {
  if (!widget || ids.length === 0) return;
  const chart = safeChart(widget);
  if (!chart) return;
  for (const id of ids) {
    try { chart.removeEntity(id); } catch { /* shape may already be gone */ }
  }
}

function drawShapes(widget: TvWidget, lines: PositionLine[]): string[] {
  if (!widget || lines.length === 0) return [];
  const chart = safeChart(widget);
  if (!chart || typeof chart.createShape !== "function") return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const ids: string[] = [];
  for (const line of lines) {
    try {
      const id = chart.createShape(
        { time: nowSec, price: line.price },
        {
          shape: "horizontal_line",
          text:  line.label,
          overrides: {
            linecolor: line.color,
            linewidth: line.lineWidth ?? 2,
            linestyle: line.lineStyle ?? 0,
          },
        },
      );
      if (id) ids.push(id as string);
    } catch { /* createShape not available in free widget — overlay handles it */ }
  }
  return ids;
}

// ── Component ─────────────────────────────────────────────────────────────────

let _uid = 0;

interface TradingViewChartProps {
  symbol:         string;
  interval?:      string;
  positionLines?: PositionLine[];
  /** Current live mid-price for overlay range seeding */
  livePrice?:     number;
  /** Called with (ourSymbol, rawPrice) on every real-time tick intercepted
   *  from the widget's postMessage stream. Fires at the same time the chart
   *  visually updates — use this price for the Buy/Sell buttons for zero gap. */
  onPriceTick?:   (symbol: string, price: number) => void;
}

export function TradingViewChart({
  symbol,
  interval      = "15",
  positionLines = [],
  livePrice,
  onPriceTick,
}: TradingViewChartProps) {

  const wrapperRef     = useRef<HTMLDivElement>(null);
  const widgetRef      = useRef<TvWidget>(null);
  const chartReadyRef  = useRef(false);
  const lineEntityIds  = useRef<string[]>([]);
  const latestLinesRef = useRef<PositionLine[]>(positionLines);
  const prevLinesKey   = useRef<string>("");
  const onTickRef      = useRef(onPriceTick);
  onTickRef.current    = onPriceTick;

  // Symbol ref — needed inside the once-mounted postMessage handler
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  // ── Rolling price buffer — feeds the overlay range estimator ─────────────
  const priceBufferRef = useRef<number[]>([]);
  const MAX_BUFFER = 300;

  // Computed visible range for the overlay (updates every second)
  const [overlayRange, setOverlayRange] = useState<{ lo: number; hi: number } | null>(null);

  // Seed range immediately when livePrice or symbol changes
  useEffect(() => {
    const center = livePrice;
    if (!center) return;
    const buf = priceBufferRef.current;
    if (buf.length >= 10) {
      const lo  = Math.min(...buf);
      const hi  = Math.max(...buf);
      const pad = Math.max((hi - lo) * 0.35, SYMBOL_HALF_RANGE[symbol] ?? center * 0.01);
      setOverlayRange({ lo: lo - pad, hi: hi + pad });
    } else {
      const half = SYMBOL_HALF_RANGE[symbol] ?? center * 0.01;
      setOverlayRange({ lo: center - half, hi: center + half });
    }
  }, [livePrice, symbol]);

  // Refine range from buffer every second
  useEffect(() => {
    const id = setInterval(() => {
      const buf = priceBufferRef.current;
      if (buf.length < 10) return;
      const lo  = Math.min(...buf);
      const hi  = Math.max(...buf);
      const pad = Math.max((hi - lo) * 0.35, (SYMBOL_HALF_RANGE[symbol] ?? (hi + lo) / 2 * 0.01));
      setOverlayRange({ lo: lo - pad, hi: hi + pad });
    }, 1000);
    return () => clearInterval(id);
  }, [symbol]);

  // ── Effect: postMessage listener ─────────────────────────────────────────────
  useEffect(() => {
    const handleMessage = (evt: MessageEvent) => {
      try {
        const raw = evt.data;

        const dispatch = (tvSym: string, lp: number) => {
          const ourSym = TV_SYMBOLS_REVERSE[tvSym];
          if (!ourSym) return;
          // Feed price buffer for overlay range
          if (ourSym === symbolRef.current) {
            priceBufferRef.current.push(lp);
            if (priceBufferRef.current.length > MAX_BUFFER) {
              priceBufferRef.current.splice(0, priceBufferRef.current.length - MAX_BUFFER);
            }
          }
          onTickRef.current?.(ourSym, lp);
        };

        // Path A: wire protocol string ~m~N~m~{JSON}
        if (typeof raw === "string" && raw.includes("~m~")) {
          for (const packet of parseTvWirePackets(raw)) {
            if (!packet.startsWith("{")) continue;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const msg = JSON.parse(packet) as any;
              if (msg.m === "qsd" && Array.isArray(msg.p) && msg.p.length >= 2) {
                const info  = msg.p[1];
                const lp    = info?.v?.lp;
                const tvSym = info?.n as string | undefined;
                if (typeof lp === "number" && lp > 0 && tvSym) dispatch(tvSym, lp);
              }
            } catch { /* skip malformed packet */ }
          }
          return;
        }

        // Path B: plain JSON object
        if (raw && typeof raw === "object") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = raw as any;
          if (msg.name === "quoteUpdate" || msg.name === "quote_update") {
            const data  = msg.data ?? msg;
            const lp    = data?.lp ?? data?.v?.lp ?? data?.price;
            const tvSym = data?.n  ?? data?.symbol;
            if (typeof lp === "number" && lp > 0 && tvSym) dispatch(tvSym as string, lp);
          }
          if (msg.m === "qsd" && Array.isArray(msg.p) && msg.p.length >= 2) {
            const info  = msg.p[1];
            const lp    = info?.v?.lp;
            const tvSym = info?.n as string | undefined;
            if (typeof lp === "number" && lp > 0 && tvSym) dispatch(tvSym, lp);
          }
        }

        // Path C: JSON-encoded string
        if (typeof raw === "string" && raw.startsWith("{")) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = JSON.parse(raw) as any;
            const lp    = msg?.lp ?? msg?.price ?? msg?.data?.lp ?? msg?.v?.lp;
            const tvSym = msg?.n  ?? msg?.symbol ?? msg?.data?.n ?? msg?.data?.symbol;
            if (typeof lp === "number" && lp > 0 && tvSym) dispatch(tvSym as string, lp);
          } catch { /* ignore */ }
        }
      } catch { /* ignore any top-level parse failure */ }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // ── Effect 1: create / recreate the widget on symbol or interval change ──────
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const wrapper = wrapperRef.current!;
    if (!wrapper) return;

    chartReadyRef.current = false;
    lineEntityIds.current = [];
    prevLinesKey.current  = "";
    widgetRef.current     = null;
    priceBufferRef.current = [];   // reset price buffer on symbol change
    wrapper.innerHTML     = "";

    const id  = `tv_${++_uid}`;
    const div = document.createElement("div");
    div.id          = id;
    div.style.width  = "100%";
    div.style.height = "100%";
    wrapper.appendChild(div);

    const tvSymbol = TV_SYMBOLS[symbol] ?? `OANDA:${symbol}`;
    let cancelled  = false;

    function phase1(w: TvWidget, attempt = 0) {
      if (cancelled || !wrapper.contains(div)) return;
      if (typeof w?.onChartReady === "function") {
        try {
          w.onChartReady(() => {
            if (cancelled || !wrapper.contains(div)) return;
            markReady(w);
          });
          return;
        } catch { /* fall through to phase 2 */ }
      }
      if (attempt < 50) setTimeout(() => phase1(w, attempt + 1), 100);
      else phase2(w);
    }

    function phase2(w: TvWidget, attempt = 0) {
      if (cancelled || !wrapper.contains(div)) return;
      try {
        const chart = w?.activeChart?.() ?? w?.chart?.();
        if (chart && typeof chart.createShape === "function") {
          markReady(w); return;
        }
      } catch { /* not ready yet */ }
      if (attempt < 30) setTimeout(() => phase2(w, attempt + 1), 500);
    }

    function markReady(w: TvWidget) {
      if (cancelled || !wrapper.contains(div)) return;
      chartReadyRef.current = true;
      widgetRef.current     = w;
      lineEntityIds.current = drawShapes(w, latestLinesRef.current);
      prevLinesKey.current  = JSON.stringify(latestLinesRef.current);
    }

    whenTvReady(() => {
      if (cancelled || !wrapper.contains(div)) return;

      // @ts-expect-error TradingView injected at runtime via tv.js
      const w: TvWidget = new window.TradingView.widget({
        container_id:        id,
        autosize:            true,
        symbol:              tvSymbol,
        interval:            interval,
        timezone:            "Etc/UTC",
        theme:               "dark",
        style:               "1",
        locale:              "en",
        toolbar_bg:          "#0a0b0e",
        enable_publishing:   false,
        allow_symbol_change: false,
        hide_side_toolbar:   false,
        hide_top_toolbar:    false,
        withdateranges:      true,
        save_image:          false,
        show_popup_button:   false,
        disabled_features: [
          "show_bid_ask_labels",
          "show_last_bid_ask",
          "show_spread_operator",
        ],
        enabled_features: [],
        studies: [
          "RSI@tv-basicstudies",
          "MASimple@tv-basicstudies",
        ],
      });

      phase1(w);
    });

    return () => {
      cancelled             = true;
      chartReadyRef.current = false;
      lineEntityIds.current = [];
      widgetRef.current     = null;
      wrapper.innerHTML     = "";
    };
  // positionLines intentionally omitted — handled by Effect 2
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  // ── Effect 2: redraw shapes when open-trade set changes ───────────────────────
  useEffect(() => {
    latestLinesRef.current = positionLines;

    const key = JSON.stringify(positionLines);
    if (key === prevLinesKey.current) return;
    prevLinesKey.current = key;

    if (!chartReadyRef.current) return;

    const w = widgetRef.current;
    clearShapes(w, lineEntityIds.current);
    lineEntityIds.current = drawShapes(w, positionLines);
  }, [positionLines]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-full relative">
      {/* TradingView widget container */}
      <div ref={wrapperRef} className="absolute inset-0" />

      {/* ── CSS overlay — guaranteed-to-work position lines ── */}
      {overlayRange && positionLines.length > 0 && (() => {
        const { lo, hi } = overlayRange;
        const span = hi - lo;
        if (span <= 0) return null;

        return (
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
            {positionLines.map((line, i) => {
              const rawPct = ((hi - line.price) / span) * 100;
              // Skip if well outside visible range
              if (rawPct < -3 || rawPct > 103) return null;
              const pct     = Math.max(0.5, Math.min(99.5, rawPct));
              const isDashed = (line.lineStyle ?? 0) !== 0;
              const lw       = line.lineWidth ?? (isDashed ? 1 : 2);

              return (
                <div
                  key={`pl-${i}`}
                  className="absolute left-0 right-0"
                  style={{ top: `${pct}%` }}
                >
                  {/* Horizontal line — stops before right badge */}
                  <div
                    style={{
                      position:        "absolute",
                      left:            0,
                      right:           88,
                      top:             0,
                      transform:       "translateY(-50%)",
                      height:          isDashed ? 0 : lw,
                      backgroundColor: isDashed ? "transparent" : line.color,
                      borderTop:       isDashed ? `${lw}px dashed ${line.color}` : "none",
                      opacity:         0.85,
                    }}
                  />
                  {/* Price badge on right — mirrors the TV price-axis style */}
                  <div
                    style={{
                      position:    "absolute",
                      right:       2,
                      top:         0,
                      transform:   "translateY(-50%)",
                      background:  line.color,
                      color:       "#fff",
                      fontSize:    10,
                      fontFamily:  "monospace",
                      fontWeight:  700,
                      padding:     "2px 6px",
                      borderRadius: 3,
                      whiteSpace:  "nowrap",
                      lineHeight:  "1.4",
                      boxShadow:   `0 1px 6px ${line.color}55`,
                    }}
                  >
                    {line.label}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
