import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";

export interface WsSymbolPrice {
  symbol:    string;
  name:      string;
  bid:       number;   // raw + current server offset (mid-price)
  ask:       number;
  raw:       number;   // price direct from data source, NO offset applied
  spread:    number;   // full spread in price units (admin-configured)
  change:    number;
  changePct: number;
  prev:      number;
  trending:  "up" | "down" | "flat";
  high:      number;
  low:       number;
  timestamp: string;
}

interface TradingContextValue {
  prices:              Record<string, WsSymbolPrice>;
  watchlist:           WsSymbolPrice[];
  connected:           boolean;
  activeSymbol:        string;
  setActiveSymbol:     (s: string) => void;
  /** Current admin price offsets, fetched every 5 s. Key = symbol, value = offset. */
  offsets:             Record<string, number>;
  /** Global commission per trade (USD), fetched every 30 s. */
  commissionPerTrade:  number;
}

const TradingContext = createContext<TradingContextValue | null>(null);

const WS_URL = (() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
})();

const HTTP_WATCHLIST = "/api/market/watchlist";

// How long with no WS message before we consider the connection stalled
const HEARTBEAT_TIMEOUT_MS = 6_000;   // 6 s (backend pushes every 5 s minimum)
// HTTP fallback poll interval while WS is down or stalled
const FALLBACK_POLL_MS     = 1_000;   // 1 s
// Reconnect backoff: starts at 1 s, doubles up to 8 s
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 8_000;

export function TradingProvider({ children }: { children: ReactNode }) {
  // ── Ref-based price store: WS messages write here synchronously (zero
  // React overhead).  A requestAnimationFrame loop flushes to React state
  // at the display refresh rate.
  const pricesRef = useRef<Record<string, WsSymbolPrice>>({});
  const dirtyRef  = useRef(false);
  const rafRef    = useRef<number>(0);

  const [prices,             setPrices]             = useState<Record<string, WsSymbolPrice>>({});
  const [connected,          setConnected]          = useState(false);
  const [activeSymbol,       setActiveSymbol]       = useState("XAUUSD");
  const [offsets,            setOffsets]            = useState<Record<string, number>>({});
  const [commissionPerTrade, setCommissionPerTrade] = useState(0);

  const wsRef          = useRef<WebSocket | null>(null);
  const retryRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryDelayRef  = useRef(MIN_RETRY_MS);
  const connectedRef   = useRef(false);  // mirror of `connected` readable in callbacks

  // ── RAF loop: flushes pricesRef → React state at screen refresh rate ─────
  useEffect(() => {
    const loop = () => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setPrices({ ...pricesRef.current });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Apply a batch of price updates to the ref store ───────────────────────
  const applyPrices = useCallback((items: WsSymbolPrice[]) => {
    for (const item of items) {
      pricesRef.current[item.symbol] = item;
    }
    dirtyRef.current = true;
  }, []);

  // ── HTTP fallback: poll /api/market/watchlist every 1 s ──────────────────
  // Active only while the WS is disconnected or stalled.
  const startFallback = useCallback(() => {
    if (fallbackRef.current) return;                          // already running
    fallbackRef.current = setInterval(async () => {
      try {
        const res = await fetch(HTTP_WATCHLIST, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json() as WsSymbolPrice[];
        if (Array.isArray(data)) applyPrices(data);
      } catch { /* ignore network errors */ }
    }, FALLBACK_POLL_MS);
  }, [applyPrices]);

  const stopFallback = useCallback(() => {
    if (fallbackRef.current) {
      clearInterval(fallbackRef.current);
      fallbackRef.current = null;
    }
  }, []);

  // ── Heartbeat watchdog ────────────────────────────────────────────────────
  // Resets on every WS message.  If it fires, the connection is silently
  // stalled — force-close to trigger a reconnect.
  const resetHeartbeat = useCallback(() => {
    if (heartbeatRef.current) clearTimeout(heartbeatRef.current);
    heartbeatRef.current = setTimeout(() => {
      // No message for HEARTBEAT_TIMEOUT_MS — connection is stalled
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();   // triggers onclose → reconnect
      }
      startFallback();
    }, HEARTBEAT_TIMEOUT_MS);
  }, [startFallback]);

  // ── WebSocket connect / reconnect ─────────────────────────────────────────
  const connect = useCallback(() => {
    // Don't open a second socket if one is already connecting or open
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    const socket = new WebSocket(WS_URL);
    wsRef.current = socket;

    socket.onopen = () => {
      setConnected(true);
      connectedRef.current = true;
      retryDelayRef.current = MIN_RETRY_MS;   // reset backoff on success
      stopFallback();
      resetHeartbeat();
    };

    socket.onmessage = (evt) => {
      // ── Hot path: write to ref synchronously — no setState ───────────────
      try {
        const msg = JSON.parse(evt.data as string) as { type: string; data: WsSymbolPrice[] };
        if (msg.type === "prices" && Array.isArray(msg.data)) {
          applyPrices(msg.data);
          resetHeartbeat();   // connection is alive — reset watchdog
        }
      } catch { /* ignore malformed frames */ }
    };

    socket.onclose = () => {
      setConnected(false);
      connectedRef.current = false;
      if (heartbeatRef.current) clearTimeout(heartbeatRef.current);

      // Start HTTP fallback immediately so prices never freeze during reconnect
      startFallback();

      // Exponential backoff reconnect
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_MS);
      retryRef.current = setTimeout(connect, delay);
    };

    socket.onerror = () => socket.close();
  }, [applyPrices, resetHeartbeat, startFallback, stopFallback]);

  useEffect(() => {
    connect();
    // Kick off fallback immediately — covers the window before the WS opens
    startFallback();
    return () => {
      if (retryRef.current)    clearTimeout(retryRef.current);
      if (heartbeatRef.current) clearTimeout(heartbeatRef.current);
      stopFallback();
      wsRef.current?.close();
    };
  }, [connect, startFallback, stopFallback]);

  // ── Offset polling: fetch admin price offsets every 5 s ──────────────────
  useEffect(() => {
    const fetchOffsets = () => {
      fetch("/api/admin/price-offsets", { credentials: "include" })
        .then(r => r.ok ? r.json() as Promise<Record<string, number>> : Promise.resolve({}))
        .then(data => setOffsets(data))
        .catch(() => {/* ignore — server may return 401 for non-admins */});
    };
    fetchOffsets();
    const id = setInterval(fetchOffsets, 5_000);
    return () => clearInterval(id);
  }, []);

  // ── Commission polling: fetch global commission every 30 s ────────────────
  useEffect(() => {
    const fetchCommission = () => {
      fetch("/api/market/commission", { credentials: "include" })
        .then(r => r.ok ? r.json() as Promise<{ commissionPerTrade: number }> : Promise.resolve(null))
        .then(data => { if (data) setCommissionPerTrade(data.commissionPerTrade ?? 0); })
        .catch(() => {/* ignore */});
    };
    fetchCommission();
    const id = setInterval(fetchCommission, 30_000);
    return () => clearInterval(id);
  }, []);

  const watchlist = Object.values(prices);

  return (
    <TradingContext.Provider value={{
      prices, watchlist, connected, activeSymbol, setActiveSymbol,
      offsets, commissionPerTrade,
    }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext(): TradingContextValue {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTradingContext must be used inside TradingProvider");
  return ctx;
}
