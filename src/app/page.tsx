"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type GpuRow = {
  ts: string;
  util_pct: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  temp_c: number | null;
  power_w: number | null;
};

type SystemRow = {
  ts: string;
  cpu_pct: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
};

type ModelRow = {
  ts: string;
  tok_s: number | null;
  ctx_used: number | null;
  ctx_total: number | null;
  status: string | null;
  activity: string | null;
  prompt_progress: number | null;
};

type ServiceRow = {
  ts: string;
  service: string;
  status: string;
  detail: string | null;
};

type EventRow = {
  ts: string;
  kind: string;
  message: string;
  severity: string;
};

const POLL_MS = 2000;
const PULL_THRESHOLD = 70;
const PULL_MAX = 110;

function timeAgo(ts: string | number | undefined) {
  if (!ts) return "sin datos";
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  return `hace ${h}h`;
}

function isStale(ts: string | undefined, maxSeconds = 120) {
  if (!ts) return true;
  return Date.now() - new Date(ts).getTime() > maxSeconds * 1000;
}

function modelActivityLabel(model: ModelRow | undefined) {
  if (!model) return "—";
  if (model.status !== "ok") return model.status === "loading" ? "Cargando modelo…" : "Apagado";
  if (model.activity === "prompt") {
    const pct = model.prompt_progress != null ? ` ${Math.round(model.prompt_progress * 100)}%` : "";
    return `Leyendo contexto…${pct}`;
  }
  if (model.activity === "generating") {
    return model.tok_s ? `Generando · ${model.tok_s.toFixed(1)} tok/s` : "Generando…";
  }
  return "En espera";
}

/** Devuelve true durante un instante cada vez que cambia `key`. */
function useFlash(key: string | undefined, ms = 700) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(key);
  useEffect(() => {
    if (key && prev.current && key !== prev.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), ms);
      prev.current = key;
      return () => clearTimeout(t);
    }
    prev.current = key;
  }, [key, ms]);
  return flash;
}

function Spinner({ className = "h-4 w-4", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Card({
  title,
  stale,
  loading,
  flashKey,
  children,
}: {
  title: string;
  stale?: boolean;
  loading?: boolean;
  flashKey?: string;
  children: React.ReactNode;
}) {
  const flash = useFlash(flashKey);
  return (
    <div
      className={`rounded-xl border bg-zinc-900 p-4 shadow-sm transition-colors duration-700 ${
        flash ? "border-sky-500/60 bg-zinc-800/80" : "border-zinc-800"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">{title}</h2>
        {loading ? (
          <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
        ) : (
          stale && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
              sin datos recientes
            </span>
          )
        )}
      </div>
      {loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-6 w-24 rounded bg-zinc-800" />
          <div className="h-3 w-32 rounded bg-zinc-800" />
          <div className="h-3 w-20 rounded bg-zinc-800" />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function LiveIndicator({
  lastOkAt,
  failing,
  fetching,
}: {
  lastOkAt: number | undefined;
  failing: boolean;
  fetching: boolean;
}) {
  const late = lastOkAt == null || Date.now() - lastOkAt > POLL_MS * 5;
  const bad = failing || late;
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      {fetching ? (
        <Spinner className="h-3 w-3 animate-spin text-sky-400" />
      ) : (
        <span className="relative flex h-2.5 w-2.5">
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${
              bad ? "bg-amber-400" : "bg-emerald-400"
            }`}
          />
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${bad ? "bg-amber-400" : "bg-emerald-400"}`}
          />
        </span>
      )}
      <span className={bad ? "text-amber-400" : "text-emerald-400"}>{bad ? "Reconectando" : "En vivo"}</span>
      <span className="text-zinc-500">· {lastOkAt ? timeAgo(lastOkAt) : "conectando…"}</span>
    </div>
  );
}

export default function Home() {
  const [gpu, setGpu] = useState<GpuRow>();
  const [system, setSystem] = useState<SystemRow>();
  const [model, setModel] = useState<ModelRow>();
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [failing, setFailing] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number>();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFetching(true);
    try {
      const [gpuRes, sysRes, modelRes, svcRes, evtRes] = await Promise.all([
        supabase.from("gpu_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("system_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("model_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("service_status").select("*").order("ts", { ascending: false }).limit(10),
        supabase.from("events").select("*").order("ts", { ascending: false }).limit(20),
      ]);
      const error = gpuRes.error || sysRes.error || modelRes.error || svcRes.error || evtRes.error;
      if (error) throw error;

      setGpu(gpuRes.data?.[0]);
      setSystem(sysRes.data?.[0]);
      setModel(modelRes.data?.[0]);
      const latestByService = new Map<string, ServiceRow>();
      for (const row of (svcRes.data ?? []) as ServiceRow[]) {
        if (!latestByService.has(row.service)) latestByService.set(row.service, row);
      }
      setServices(Array.from(latestByService.values()));
      setEvents((evtRes.data ?? []) as EventRow[]);
      setFailing(false);
      setLastOkAt(Date.now());
      setLoading(false);
    } catch {
      setFailing(true);
    } finally {
      inFlight.current = false;
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    const tickInterval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(tickInterval);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    let startY: number | null = null;
    let current = 0;

    const onStart = (e: TouchEvent) => {
      if (window.scrollY <= 0 && !refreshing) startY = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 0) {
        current = 0;
        setPull(0);
        return;
      }
      e.preventDefault();
      current = Math.min(PULL_MAX, dy * 0.5);
      setPull(current);
    };
    const onEnd = async () => {
      if (startY == null) return;
      startY = null;
      if (current >= PULL_THRESHOLD) {
        setRefreshing(true);
        setPull(PULL_THRESHOLD);
        if ("vibrate" in navigator) navigator.vibrate?.(10);
        const minDelay = new Promise((r) => setTimeout(r, 700));
        await Promise.all([load(), minDelay]);
        setRefreshing(false);
      }
      current = 0;
      setPull(0);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [load, refreshing]);

  const modelBusy = model?.status === "ok" && (model.activity === "prompt" || model.activity === "generating");
  const pullReady = pull >= PULL_THRESHOLD;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-10 flex justify-center"
        style={{
          transform: `translateY(${pull - 44}px)`,
          opacity: Math.min(1, pull / PULL_THRESHOLD),
          transition: pull === 0 || refreshing ? "transform 250ms ease, opacity 250ms ease" : "none",
        }}
      >
        <div className="mt-2 flex h-9 w-9 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 shadow-lg">
          <Spinner
            className={`h-5 w-5 ${pullReady || refreshing ? "text-sky-400" : "text-zinc-400"} ${
              refreshing ? "animate-spin" : ""
            }`}
            style={refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }}
          />
        </div>
      </div>

      <div
        className="px-4 py-6"
        style={{
          transform: `translateY(${pull}px)`,
          transition: pull === 0 || refreshing ? "transform 250ms ease" : "none",
        }}
      >
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">✦ Hermes Stars</h1>
          <LiveIndicator lastOkAt={lastOkAt} failing={failing} fetching={fetching || refreshing} />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card title="Modelo local" stale={isStale(model?.ts)} loading={loading} flashKey={model?.ts}>
            <div className="flex items-center gap-2">
              {modelBusy ? (
                <Spinner className="h-5 w-5 animate-spin text-sky-400" />
              ) : (
                <span
                  className={`h-2.5 w-2.5 rounded-full ${model?.status === "ok" ? "bg-emerald-400" : "bg-red-400"}`}
                />
              )}
              <p className="text-2xl font-bold">{modelActivityLabel(model)}</p>
            </div>
            {model?.activity === "prompt" && model.prompt_progress != null && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-sky-400 transition-all duration-500"
                  style={{ width: `${Math.round(model.prompt_progress * 100)}%` }}
                />
              </div>
            )}
            <p className="mt-1 text-sm text-zinc-400">
              Contexto: {model?.ctx_used ?? "—"} / {model?.ctx_total ?? "—"}
            </p>
            <p className="text-sm text-zinc-400">Estado: {model?.status ?? "desconocido"}</p>
            <p className="mt-1 text-xs text-zinc-500">{timeAgo(model?.ts)}</p>
          </Card>

          <Card title="GPU" stale={isStale(gpu?.ts)} loading={loading} flashKey={gpu?.ts}>
            <p className="text-2xl font-bold">{gpu?.util_pct != null ? `${gpu.util_pct}%` : "—"}</p>
            <p className="text-sm text-zinc-400">
              VRAM: {gpu?.vram_used_mb ?? "—"} / {gpu?.vram_total_mb ?? "—"} MB
            </p>
            <p className="text-sm text-zinc-400">
              {gpu?.temp_c != null ? `${gpu.temp_c}°C` : "—"} · {gpu?.power_w != null ? `${gpu.power_w}W` : "—"}
            </p>
            <p className="mt-1 text-xs text-zinc-500">{timeAgo(gpu?.ts)}</p>
          </Card>

          <Card title="PC (CPU / RAM)" stale={isStale(system?.ts)} loading={loading} flashKey={system?.ts}>
            <p className="text-2xl font-bold">{system?.cpu_pct != null ? `${system.cpu_pct}% CPU` : "—"}</p>
            <p className="text-sm text-zinc-400">
              RAM: {system?.ram_used_mb ?? "—"} / {system?.ram_total_mb ?? "—"} MB
            </p>
            <p className="mt-1 text-xs text-zinc-500">{timeAgo(system?.ts)}</p>
          </Card>

          <Card
            title="Servicios"
            stale={services.length === 0}
            loading={loading}
            flashKey={services.map((s) => `${s.service}:${s.status}`).join("|")}
          >
            <ul className="space-y-1 text-sm">
              {services.length === 0 && <li className="text-zinc-500">sin datos</li>}
              {services.map((s) => (
                <li key={s.service} className="flex items-center justify-between">
                  <span>{s.service}</span>
                  <span
                    className={
                      s.status === "ok" ? "text-emerald-400" : s.status === "warn" ? "text-amber-400" : "text-red-400"
                    }
                  >
                    {s.status}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Eventos en vivo" stale={events.length === 0} loading={loading} flashKey={events[0]?.ts}>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
              {events.length === 0 && <li className="text-zinc-500">sin eventos</li>}
              {events.map((e, i) => (
                <li key={`${e.ts}-${i}`} className="border-b border-zinc-800 pb-1 last:border-0">
                  <span className="text-zinc-500">{timeAgo(e.ts)}</span> — {e.message}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
