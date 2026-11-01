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
  gen_tokens: number | null;
  prompt_done: number | null;
  prompt_total: number | null;
  gen_tok_s: number | null;
  prompt_tok_s: number | null;
  task_elapsed_s: number | null;
  last_response_s: number | null;
  compress_threshold: number | null;
  compress_since: string | null;
  compress_model: string | null;
  compress_provider: string | null;
};

type CloudRow = {
  ts: string;
  balance_usd: number | null;
  spend_day_usd: number | null;
  spend_week_usd: number | null;
  spend_month_usd: number | null;
  key_remaining_usd: number | null;
  fallback_chain: string | null;
  fallback_count_24h: number | null;
  last_fallback_ts: string | null;
  last_fallback_model: string | null;
  compression_model: string | null;
  compression_count_24h: number | null;
  last_compression_ts: string | null;
  last_compression_model: string | null;
  last_compression_provider: string | null;
  last_compression_s: number | null;
  last_compression_tokens: number | null;
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

const nf = new Intl.NumberFormat("es-CL");

function fmtInt(n: number | null | undefined) {
  return n == null ? "—" : nf.format(Math.round(n));
}

function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return `US$${n.toLocaleString("es-CL", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function shortModel(id: string | null | undefined) {
  if (!id) return "—";
  return id.split("/").pop() ?? id;
}

type ModelView = {
  busy: boolean;
  tone: "ok" | "busy" | "warn" | "down";
  title: string;
  detail: string;
  progress?: number;
};

function describeModel(model: ModelRow | undefined): ModelView {
  if (!model) return { busy: false, tone: "warn", title: "Sin datos", detail: "Esperando al recolector del PC" };
  if (model.status === "down") {
    return { busy: false, tone: "down", title: "Apagado", detail: "Modo noche o servicio detenido" };
  }
  if (model.status === "loading") {
    return { busy: true, tone: "warn", title: "Arrancando el modelo…", detail: "Cargando la IA en la GPU (~20 s)" };
  }
  if (model.compress_since) {
    const where =
      model.compress_provider && model.compress_provider !== "custom"
        ? `en la nube con ${shortModel(model.compress_model)}`
        : "en el modelo local";
    const elapsed = (Date.now() - new Date(model.compress_since).getTime()) / 1000;
    return {
      busy: true,
      tone: "busy",
      title: "Comprimiendo la conversación",
      detail: `Resumiendo lo antiguo ${where} · lleva ${fmtDuration(elapsed)}`,
    };
  }
  if (model.activity === "prompt") {
    const parts = [`${fmtInt(model.prompt_done)} de ${fmtInt(model.prompt_total)} tokens`];
    if (model.prompt_progress != null) parts[0] += ` (${Math.round(model.prompt_progress * 100)} %)`;
    if (model.prompt_tok_s) {
      parts.push(`${fmtInt(model.prompt_tok_s)} tok/s`);
      if (model.prompt_total != null && model.prompt_done != null) {
        parts.push(`~${fmtDuration((model.prompt_total - model.prompt_done) / model.prompt_tok_s)} restante`);
      }
    }
    if (model.task_elapsed_s != null) parts.push(`turno lleva ${fmtDuration(model.task_elapsed_s)}`);
    return {
      busy: true,
      tone: "busy",
      title: "Leyendo la conversación",
      detail: parts.join(" · "),
      progress: model.prompt_progress ?? undefined,
    };
  }
  if (model.activity === "generating") {
    const speed = model.gen_tok_s ?? model.tok_s;
    const parts = [`${fmtInt(model.gen_tokens)} tokens escritos`];
    if (speed) parts.push(`${speed.toLocaleString("es-CL", { maximumFractionDigits: 1 })} tok/s`);
    if (model.task_elapsed_s != null) parts.push(`turno lleva ${fmtDuration(model.task_elapsed_s)}`);
    return { busy: true, tone: "busy", title: "Escribiendo respuesta", detail: parts.join(" · ") };
  }
  return {
    busy: false,
    tone: "ok",
    title: "Libre",
    detail:
      model.last_response_s != null
        ? `Esperando tu mensaje · la última respuesta tardó ${fmtDuration(model.last_response_s)}`
        : "Esperando tu mensaje",
  };
}

function ContextBar({ model }: { model: ModelRow | undefined }) {
  const used = model?.ctx_used;
  const total = model?.ctx_total;
  if (used == null || !total) {
    return <p className="mt-3 text-sm text-zinc-500">Contexto: sin datos</p>;
  }
  const threshold = model?.compress_threshold ?? null;
  const pct = Math.min(100, (used / total) * 100);
  const thPct = threshold ? Math.min(100, (threshold / total) * 100) : null;
  const left = threshold != null ? threshold - used : null;
  const barColor = left != null && left <= 0 ? "bg-amber-400" : pct > 70 ? "bg-violet-400" : "bg-emerald-400";
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-zinc-400">Contexto</span>
        <span className="text-zinc-300">
          {fmtInt(used)} / {fmtInt(total)} tokens <span className="text-zinc-500">({Math.round(pct)} %)</span>
        </span>
      </div>
      <div className="relative mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${barColor} transition-all duration-700`} style={{ width: `${pct}%` }} />
        {thPct != null && <div className="absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: `${thPct}%` }} />}
      </div>
      {left != null && (
        <p className="mt-1 text-xs text-zinc-500">
          {left > 0
            ? `Se comprime a los ${fmtInt(threshold)} tokens (faltan ${fmtInt(left)})`
            : `Pasó el umbral de ${fmtInt(threshold)}: se va a comprimir en el próximo paso`}
        </p>
      )}
    </div>
  );
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
  const [cloud, setCloud] = useState<CloudRow>();
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
      const [gpuRes, sysRes, modelRes, svcRes, evtRes, cloudRes] = await Promise.all([
        supabase.from("gpu_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("system_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("model_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("service_status").select("*").order("ts", { ascending: false }).limit(10),
        supabase.from("events").select("*").order("ts", { ascending: false }).limit(20),
        supabase.from("cloud_metrics").select("*").order("ts", { ascending: false }).limit(1),
      ]);
      const error = gpuRes.error || sysRes.error || modelRes.error || svcRes.error || evtRes.error || cloudRes.error;
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
      setCloud(cloudRes.data?.[0]);
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

  const modelView = describeModel(model);
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
          <Card title="Modelo local · Qwen3.6-35B" stale={isStale(model?.ts)} loading={loading} flashKey={model?.ts}>
            <div className="flex items-center gap-2">
              {modelView.busy ? (
                <Spinner className="h-5 w-5 shrink-0 animate-spin text-sky-400" />
              ) : (
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                    modelView.tone === "ok" ? "bg-emerald-400" : modelView.tone === "down" ? "bg-red-400" : "bg-amber-400"
                  }`}
                />
              )}
              <p className="text-xl font-bold">{modelView.title}</p>
            </div>
            <p className="mt-1 text-sm text-zinc-300">{modelView.detail}</p>
            {modelView.progress != null && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-sky-400 transition-all duration-500"
                  style={{ width: `${Math.round(modelView.progress * 100)}%` }}
                />
              </div>
            )}
            <ContextBar model={model} />
            <p className="mt-2 text-xs text-zinc-500">{timeAgo(model?.ts)}</p>
          </Card>

          <Card title="Nube · OpenRouter" stale={isStale(cloud?.ts, 180)} loading={loading} flashKey={cloud?.ts}>
            <div className="flex items-baseline justify-between">
              <p className="text-xl font-bold">{fmtUsd(cloud?.balance_usd)}</p>
              <span className="text-xs text-zinc-500">saldo de la cuenta</span>
            </div>
            <p className="text-sm text-zinc-400">
              Gastado hoy {fmtUsd(cloud?.spend_day_usd)} · semana {fmtUsd(cloud?.spend_week_usd)} · mes{" "}
              {fmtUsd(cloud?.spend_month_usd)}
            </p>

            <div className="mt-3 border-t border-zinc-800 pt-2">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Compresión</p>
              <p className="text-sm text-zinc-200">{shortModel(cloud?.compression_model)}</p>
              <p className="text-sm text-zinc-400">
                {cloud?.compression_count_24h ?? 0} en 24 h
                {cloud?.last_compression_ts && (
                  <>
                    {" "}· última {timeAgo(cloud.last_compression_ts)}, tardó {fmtDuration(cloud.last_compression_s)}
                    {cloud.last_compression_tokens != null && ` (${fmtInt(cloud.last_compression_tokens)} tokens)`}
                    {cloud.last_compression_model &&
                      cloud.last_compression_model !== cloud.compression_model &&
                      ` con ${shortModel(cloud.last_compression_model)}`}
                  </>
                )}
              </p>
            </div>

            <div className="mt-2 border-t border-zinc-800 pt-2">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Respaldo si el modelo local falla</p>
              <p className="text-sm text-zinc-200">
                {cloud?.fallback_chain ? cloud.fallback_chain.split(" → ").map(shortModel).join(" → ") : "—"}
              </p>
              <p className="text-sm text-zinc-400">
                {cloud?.fallback_count_24h
                  ? `Usado ${cloud.fallback_count_24h} ${cloud.fallback_count_24h === 1 ? "vez" : "veces"} en 24 h · último ${timeAgo(
                      cloud.last_fallback_ts ?? undefined,
                    )} (${shortModel(cloud.last_fallback_model)})`
                  : "No se usó en las últimas 24 h"}
              </p>
            </div>
            <p className="mt-2 text-xs text-zinc-500">{timeAgo(cloud?.ts)}</p>
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
