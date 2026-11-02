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

type ServiceRow = {
  ts: string;
  service: string;
  status: string;
};

type EventRow = {
  ts: string;
  kind: string;
  message: string;
  severity: string;
};

type CloudRow = {
  ts: string;
  balance_usd: number | null;
  spend_day_usd: number | null;
  spend_week_usd: number | null;
  spend_month_usd: number | null;
  fallback_chain: string | null;
  fallback_count_24h: number | null;
  last_fallback_ts: string | null;
  last_fallback_model: string | null;
  compression_model: string | null;
  compression_count_24h: number | null;
  last_compression_ts: string | null;
  last_compression_model: string | null;
  last_compression_s: number | null;
  last_compression_tokens: number | null;
};

type TurnRow = {
  turn_key: string;
  platform: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  phase: string | null;
  total_s: number | null;
  read_s: number;
  write_s: number;
  tools_s: number;
  compress_s: number;
  api_calls: number;
  tokens_out: number;
  tools: Record<string, number>;
  tool_errors: number;
  compressed: boolean;
  fallback_used: boolean;
};

const POLL_MS = 2000;
const HISTORY_MS = 10000;
const PULL_THRESHOLD = 70;
const PULL_MAX = 110;
const STALE_S = 120;

const nf = new Intl.NumberFormat("es-CL");

function fmtInt(n: number | null | undefined) {
  return n == null ? "—" : nf.format(Math.round(n));
}

function fmtDec(n: number | null | undefined, digits = 1) {
  return n == null
    ? "—"
    : n.toLocaleString("es-CL", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
}

function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}\u00A0s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}\u00A0min\u00A0${r}\u00A0s` : `${m}\u00A0min`;
}

function fmtShort(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return `US$${n.toLocaleString("es-CL", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtClock(ts: string) {
  return new Date(ts).toLocaleTimeString("es-CL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function timeAgo(ts: string | number | undefined | null) {
  if (!ts) return "sin datos";
  const s = Math.max(
    0,
    Math.floor((Date.now() - new Date(ts).getTime()) / 1000),
  );
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  return `hace ${h} h`;
}

function isStale(ts: string | undefined, maxSeconds = STALE_S) {
  if (!ts) return true;
  return Date.now() - new Date(ts).getTime() > maxSeconds * 1000;
}

function shortModel(id: string | null | undefined) {
  if (!id) return "—";
  if (id === "openrouter/free") return id;
  return id.split("/").pop() ?? id;
}

function platformName(p: string) {
  if (p.startsWith("whatsapp")) return "WhatsApp";
  if (p.startsWith("telegram")) return "Telegram";
  return p;
}

function Spinner({
  className = "h-4 w-4",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-niebla transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Bloque plegable: el encabezado siempre se ve; el detalle se abre al tocar (o solo si `forceOpen`). */
function Fold({
  summary,
  children,
  forceOpen = false,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 py-3 text-left"
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <Chevron open={open} />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="pb-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Sparkline({
  values,
  max,
  tone,
}: {
  values: number[];
  max: number;
  tone: string;
}) {
  if (values.length < 2) return <div className="h-7 w-full" />;
  const w = 100;
  const h = 28;
  const step = w / (values.length - 1);
  const pts = values.map(
    (v, i) =>
      `${(i * step).toFixed(2)},${(h - 2 - (Math.min(v, max) / max) * (h - 4)).toFixed(2)}`,
  );
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-7 w-full"
      aria-hidden="true"
    >
      <polyline
        points={`0,${h} ${pts.join(" ")} ${w},${h}`}
        fill={tone}
        fillOpacity="0.14"
        stroke="none"
      />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={tone}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

type NodeState = "done" | "active" | "pending";
type ConstellationNode = {
  key: string;
  label: string;
  detail: string;
  state: NodeState;
};

const PHASE_ORDER = [
  "msg",
  "read",
  "tools",
  "compress",
  "write",
  "sent",
] as const;

function buildConstellation(turn: TurnRow): ConstellationNode[] {
  const active = turn.status === "active";
  const interrupted = turn.status === "interrupted";
  const usedTools = turn.tools_s > 0 || Object.keys(turn.tools).length > 0;
  const currentIdx = active
    ? PHASE_ORDER.indexOf(
        (turn.phase as (typeof PHASE_ORDER)[number]) ?? "read",
      )
    : PHASE_ORDER.length;

  const defs: {
    key: (typeof PHASE_ORDER)[number];
    label: string;
    detail: string;
    include: boolean;
  }[] = [
    {
      key: "msg",
      label: "Mensaje",
      detail: platformName(turn.platform),
      include: true,
    },
    { key: "read", label: "Lee", detail: fmtShort(turn.read_s), include: true },
    {
      key: "tools",
      label: "Acciones",
      detail: fmtShort(turn.tools_s),
      include: usedTools || turn.phase === "tools",
    },
    {
      key: "compress",
      label: "Comprime",
      detail: fmtShort(turn.compress_s),
      include: turn.compressed || turn.phase === "compress",
    },
    {
      key: "write",
      label: "Escribe",
      detail: fmtShort(turn.write_s),
      include: true,
    },
    {
      key: "sent",
      label: interrupted ? "Cortado" : "Enviado",
      detail: active ? "…" : fmtShort(turn.total_s),
      include: true,
    },
  ];

  return defs
    .filter((d) => d.include)
    .map((d) => {
      const idx = PHASE_ORDER.indexOf(d.key);
      const state: NodeState = !active
        ? "done"
        : idx < currentIdx
          ? "done"
          : idx === currentIdx
            ? "active"
            : "pending";
      return { key: d.key, label: d.label, detail: d.detail, state };
    });
}

function Constellation({ turn }: { turn: TurnRow }) {
  const nodes = buildConstellation(turn);
  const width = 320;
  const padX = 26;
  const step = nodes.length > 1 ? (width - padX * 2) / (nodes.length - 1) : 0;
  const ys = nodes.map((_, i) => (i % 2 === 0 ? 24 : 40));
  const xs = nodes.map((_, i) => padX + i * step);
  const reached = nodes.filter((n) => n.state !== "pending").length;
  return (
    <div className="mt-5">
      <svg
        viewBox={`0 0 ${width} 62`}
        className="mx-auto w-full max-w-md"
        role="img"
        aria-label="Fases del turno de Orión"
      >
        {nodes.slice(0, -1).map((_, i) => (
          <line
            key={i}
            x1={xs[i]}
            y1={ys[i]}
            x2={xs[i + 1]}
            y2={ys[i + 1]}
            stroke={i + 1 < reached ? "#a78bfa" : "#2a3670"}
            strokeWidth="1.6"
            strokeDasharray={i + 1 < reached ? undefined : "3 4"}
            strokeLinecap="round"
          />
        ))}
        {nodes.map((n, i) => {
          const interruptedEnd =
            turn.status === "interrupted" && i === nodes.length - 1;
          const fill = interruptedEnd
            ? "#f87171"
            : n.state === "done"
              ? "#a78bfa"
              : n.state === "active"
                ? "#fde68a"
                : "#0f1631";
          const stroke =
            n.state === "pending"
              ? "#2a3670"
              : interruptedEnd
                ? "#f87171"
                : n.state === "active"
                  ? "#fde68a"
                  : "#a78bfa";
          return (
            <g key={n.key}>
              {n.state === "active" && (
                <circle
                  cx={xs[i]}
                  cy={ys[i]}
                  r="13"
                  fill="#fde68a"
                  fillOpacity="0.12"
                />
              )}
              <circle
                cx={xs[i]}
                cy={ys[i]}
                r={n.state === "active" ? 7 : 5}
                fill={fill}
                stroke={stroke}
                strokeWidth="1.6"
                className={n.state === "active" ? "estrella-activa" : undefined}
              />
            </g>
          );
        })}
      </svg>
      <ol
        className="mt-1 grid"
        style={{
          gridTemplateColumns: `repeat(${nodes.length}, minmax(0, 1fr))`,
        }}
      >
        {nodes.map((n) => (
          <li key={n.key} className="px-0.5 text-center">
            <p
              className={`text-[11px] leading-tight ${n.state === "active" ? "font-semibold text-oro" : n.state === "done" ? "text-luz" : "text-niebla"}`}
            >
              {n.label}
            </p>
            <p className="num text-[11px] leading-tight text-niebla">
              {n.detail}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

type ModelView = {
  busy: boolean;
  tone: "ok" | "busy" | "warn" | "down";
  title: string;
  detail: string;
  progress?: number;
};

function describeModel(model: ModelRow | undefined): ModelView {
  if (!model)
    return {
      busy: false,
      tone: "warn",
      title: "Sin datos",
      detail: "Esperando al recolector del PC",
    };
  if (model.status === "down") {
    return {
      busy: false,
      tone: "down",
      title: "Apagado",
      detail: "Modo noche o servicio detenido",
    };
  }
  if (model.status === "loading") {
    return {
      busy: true,
      tone: "warn",
      title: "Arrancando el modelo",
      detail: "Cargando la IA en la GPU (~20 s)",
    };
  }
  if (model.compress_since) {
    const where =
      model.compress_provider && model.compress_provider !== "custom"
        ? `en la nube con ${shortModel(model.compress_model)}`
        : "en el modelo local";
    const elapsed =
      (Date.now() - new Date(model.compress_since).getTime()) / 1000;
    return {
      busy: true,
      tone: "busy",
      title: "Comprimiendo la conversación",
      detail: `Resume lo antiguo ${where}. Lleva ${fmtDuration(elapsed)}.`,
    };
  }
  if (model.activity === "prompt") {
    const parts = [
      `${fmtInt(model.prompt_done)} de ${fmtInt(model.prompt_total)} tokens`,
    ];
    if (model.prompt_progress != null)
      parts[0] += ` (${Math.round(model.prompt_progress * 100)} %)`;
    if (model.prompt_tok_s) {
      parts.push(`${fmtInt(model.prompt_tok_s)} tok/s`);
      if (model.prompt_total != null && model.prompt_done != null) {
        parts.push(
          `faltan ~${fmtDuration((model.prompt_total - model.prompt_done) / model.prompt_tok_s)}`,
        );
      }
    }
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
    if (speed) parts.push(`${fmtDec(speed)} tok/s`);
    return {
      busy: true,
      tone: "busy",
      title: "Escribiendo respuesta",
      detail: parts.join(" · "),
    };
  }
  return {
    busy: false,
    tone: "ok",
    title: "Libre",
    detail:
      model.last_response_s != null
        ? `Esperando tu mensaje. La última respuesta tardó ${fmtDuration(model.last_response_s)}.`
        : "Esperando tu mensaje.",
  };
}

function ContextBar({ model }: { model: ModelRow | undefined }) {
  const total = model?.ctx_total;
  const used = model?.ctx_used ?? (total ? 0 : null);
  if (used == null || !total) {
    return <p className="mt-5 text-sm text-niebla">Contexto: sin datos</p>;
  }
  const threshold = model?.compress_threshold ?? null;
  const pct = Math.min(100, (used / total) * 100);
  const thPct = threshold ? Math.min(100, (threshold / total) * 100) : null;
  const left = threshold != null ? threshold - used : null;
  const barColor =
    left != null && left <= 0 ? "bg-aviso" : pct > 70 ? "bg-astro" : "bg-ok";
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-niebla">Memoria</span>
        <span className="num whitespace-nowrap text-luz">
          {fmtInt(used)} / {fmtInt(total)}{" "}
          <span className="text-niebla">({Math.round(pct)}&nbsp;%)</span>
        </span>
      </div>
      <div className="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-cielo">
        <div
          className={`h-full rounded-full ${barColor} transition-all duration-700 motion-reduce:transition-none`}
          style={{ width: `${pct}%` }}
        />
        {thPct != null && (
          <div
            className="absolute inset-y-0 w-0.5 bg-oro"
            style={{ left: `${thPct}%` }}
          />
        )}
      </div>
      {left != null && (
        <p className="mt-1.5 text-xs text-niebla">
          {left > 0
            ? `Se comprime al llegar a ${fmtInt(threshold)} (faltan ${fmtInt(left)}).`
            : "Pasó el umbral: se comprime antes de la próxima respuesta."}
        </p>
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
    <div className="flex items-center gap-2 text-xs text-niebla">
      {fetching ? (
        <Spinner className="h-3 w-3 motion-safe:animate-spin text-astro" />
      ) : (
        <span className="relative flex h-2.5 w-2.5">
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping ${bad ? "bg-aviso" : "bg-ok"}`}
          />
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${bad ? "bg-aviso" : "bg-ok"}`}
          />
        </span>
      )}
      <span className={bad ? "text-aviso" : "text-ok"}>
        {bad ? "Reconectando" : "En vivo"}
      </span>
      <span className="num">
        {lastOkAt ? timeAgo(lastOkAt) : "conectando…"}
      </span>
    </div>
  );
}

function Section({
  title,
  stale,
  children,
}: {
  title: string;
  stale?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-sup/60 px-4 py-4 ring-1 ring-linea/70">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-base font-semibold text-luz">
          {title}
        </h2>
        {stale && (
          <span className="rounded-full bg-aviso/15 px-2 py-0.5 text-xs text-aviso">
            sin datos recientes
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="motion-safe:animate-pulse space-y-3" aria-hidden="true">
      <div className="h-7 w-44 rounded bg-sup" />
      <div className="h-4 w-64 max-w-full rounded bg-sup" />
      <div className="h-16 w-full rounded bg-sup" />
    </div>
  );
}

function turnCause(t: TurnRow): string | null {
  if ((t.total_s ?? 0) < 60) return null;
  const parts: [string, number][] = [
    ["compresión", t.compress_s],
    ["lectura", t.read_s],
    ["herramientas", t.tools_s],
    ["escritura", t.write_s],
  ];
  const [name, secs] = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (secs < 20) return null;
  return `${name} ${fmtDuration(secs)}`;
}

function PhaseBars({ t }: { t: TurnRow }) {
  const total = Math.max(
    t.total_s ?? 0,
    t.read_s + t.tools_s + t.compress_s + t.write_s,
    1,
  );
  const rows: [string, number, string][] = [
    ["Lectura", t.read_s, "bg-astro"],
    ["Herramientas", t.tools_s, "bg-oro"],
    ["Compresión", t.compress_s, "bg-aviso"],
    ["Escritura", t.write_s, "bg-ok"],
  ];
  const toolList = Object.entries(t.tools).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2 text-sm">
      {rows
        .filter(([, v]) => v > 0)
        .map(([label, v, color]) => (
          <div key={label}>
            <div className="flex justify-between text-niebla">
              <span>{label}</span>
              <span className="num text-luz">{fmtDuration(v)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cielo">
              <div
                className={`h-full rounded-full ${color}`}
                style={{ width: `${Math.max(3, (v / total) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      <p className="num pt-1 text-xs text-niebla">
        {t.api_calls} {t.api_calls === 1 ? "llamada" : "llamadas"} al modelo ·{" "}
        {fmtInt(t.tokens_out)} tokens escritos
        {t.fallback_used && " · usó el modelo de respaldo"}
      </p>
      {toolList.length > 0 && (
        <p className="text-xs text-niebla">
          Herramientas:{" "}
          {toolList.map(([n, c]) => `${n}${c > 1 ? ` ×${c}` : ""}`).join(", ")}
          {t.tool_errors > 0 && (
            <span className="text-aviso"> · {t.tool_errors} con error</span>
          )}
        </p>
      )}
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
  const [turns, setTurns] = useState<TurnRow[]>([]);
  const [gpuHist, setGpuHist] = useState<number[]>([]);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
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
      const [gpuRes, sysRes, modelRes, svcRes, evtRes, cloudRes, turnRes] =
        await Promise.all([
          supabase
            .from("gpu_metrics")
            .select("*")
            .order("ts", { ascending: false })
            .limit(1),
          supabase
            .from("system_metrics")
            .select("*")
            .order("ts", { ascending: false })
            .limit(1),
          supabase
            .from("model_metrics")
            .select("*")
            .order("ts", { ascending: false })
            .limit(1),
          supabase
            .from("service_status")
            .select("*")
            .order("ts", { ascending: false })
            .limit(10),
          supabase
            .from("events")
            .select("*")
            .order("ts", { ascending: false })
            .limit(30),
          supabase
            .from("cloud_metrics")
            .select("*")
            .order("ts", { ascending: false })
            .limit(1),
          supabase
            .from("turns")
            .select("*")
            .order("started_at", { ascending: false })
            .limit(12),
        ]);
      const error = [
        gpuRes,
        sysRes,
        modelRes,
        svcRes,
        evtRes,
        cloudRes,
        turnRes,
      ].find((r) => r.error)?.error;
      if (error) throw error;

      setGpu(gpuRes.data?.[0]);
      setSystem(sysRes.data?.[0]);
      setModel(modelRes.data?.[0]);
      const latestByService = new Map<string, ServiceRow>();
      for (const row of (svcRes.data ?? []) as ServiceRow[]) {
        if (!latestByService.has(row.service))
          latestByService.set(row.service, row);
      }
      setServices(Array.from(latestByService.values()));
      setEvents((evtRes.data ?? []) as EventRow[]);
      setCloud(cloudRes.data?.[0]);
      setTurns((turnRes.data ?? []) as TurnRow[]);
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

  const loadHistory = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([
        supabase
          .from("gpu_metrics")
          .select("ts,util_pct")
          .order("ts", { ascending: false })
          .limit(150),
        supabase
          .from("system_metrics")
          .select("ts,cpu_pct")
          .order("ts", { ascending: false })
          .limit(150),
      ]);
      if (g.data) setGpuHist(g.data.map((r) => r.util_pct ?? 0).reverse());
      if (s.data) setCpuHist(s.data.map((r) => r.cpu_pct ?? 0).reverse());
    } catch {
      /* el historial es opcional; el resto del panel sigue funcionando */
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
    loadHistory();
    const interval = setInterval(loadHistory, HISTORY_MS);
    return () => clearInterval(interval);
  }, [loadHistory]);

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
        await Promise.all([load(), loadHistory(), minDelay]);
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
  }, [load, loadHistory, refreshing]);

  const modelView = describeModel(model);
  const pullReady = pull >= PULL_THRESHOLD;
  const heroTurn = turns.find((t) => t.status === "active") ?? turns[0];
  const heroIsLive = heroTurn?.status === "active";

  const llmStatuses = services
    .filter((s) => s.service.startsWith("llm"))
    .map((s) => s.status);
  const gateway = services.find((s) => s.service.startsWith("hermes-gateway"));
  const worst = (list: string[]) =>
    list.includes("down")
      ? "down"
      : list.includes("warn")
        ? "warn"
        : list.length
          ? "ok"
          : "none";
  const healthItems: { name: string; status: string }[] = [
    { name: "Modelo local", status: worst(llmStatuses) },
    {
      name: "Conexión de Orión (WhatsApp y Telegram)",
      status: gateway?.status ?? "none",
    },
  ];
  const healthIssue = healthItems.some(
    (h) => h.status === "down" || h.status === "warn",
  );
  const statusText = (s: string) =>
    s === "ok"
      ? "funciona"
      : s === "warn"
        ? "con problemas"
        : s === "down"
          ? "caído"
          : "sin datos";
  const statusColor = (s: string) =>
    s === "ok"
      ? "text-ok"
      : s === "warn"
        ? "text-aviso"
        : s === "down"
          ? "text-falla"
          : "text-niebla";

  const vramPct =
    gpu?.vram_used_mb != null && gpu.vram_total_mb
      ? (gpu.vram_used_mb / gpu.vram_total_mb) * 100
      : null;
  const gpuHot = (gpu?.temp_c ?? 0) >= 80;
  const vramTight = (vramPct ?? 0) >= 92;
  const gb = (mb: number | null | undefined) =>
    mb == null ? "—" : fmtDec(mb / 1024, 1);
  const cpuHigh = (system?.cpu_pct ?? 0) >= 90;

  const lowBalance = cloud?.balance_usd != null && cloud.balance_usd < 2;

  return (
    <div className="min-h-screen bg-cielo text-luz">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-10 flex justify-center"
        style={{
          transform: `translateY(${pull - 44}px)`,
          opacity: Math.min(1, pull / PULL_THRESHOLD),
          transition:
            pull === 0 || refreshing
              ? "transform 250ms ease, opacity 250ms ease"
              : "none",
        }}
      >
        <div className="mt-2 flex h-9 w-9 items-center justify-center rounded-full bg-sup shadow-lg ring-1 ring-linea">
          <Spinner
            className={`h-5 w-5 ${pullReady || refreshing ? "text-oro" : "text-niebla"} ${refreshing ? "motion-safe:animate-spin" : ""}`}
            style={
              refreshing ? undefined : { transform: `rotate(${pull * 4}deg)` }
            }
          />
        </div>
      </div>

      <div
        className="mx-auto max-w-5xl pb-16 pt-6 [@media(max-height:500px)]:pb-8 [@media(max-height:500px)]:pt-3"
        style={{
          paddingLeft: "max(1rem, env(safe-area-inset-left))",
          paddingRight: "max(1rem, env(safe-area-inset-right))",
          transform: `translateY(${pull}px)`,
          transition:
            pull === 0 || refreshing ? "transform 250ms ease" : "none",
        }}
      >
        <header className="mb-6 [@media(max-height:500px)]:mb-3 flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            <span className="text-oro" aria-hidden="true">
              ✦
            </span>{" "}
            Hermes Stars
          </h1>
          <LiveIndicator
            lastOkAt={lastOkAt}
            failing={failing}
            fetching={fetching || refreshing}
          />
        </header>

        <div className="grid gap-4 min-[700px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] min-[700px]:items-start">
          <div className="flex flex-col gap-4 min-[700px]:contents">
            <section className="rounded-2xl bg-sup px-5 py-5 ring-1 ring-linea min-[700px]:col-start-1 min-[700px]:row-start-1 [@media(max-height:500px)]:py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-niebla">
                    Orión ahora · Qwen3.6-35B
                  </p>
                  {loading ? (
                    <div className="mt-3">
                      <Skeleton />
                    </div>
                  ) : (
                    <>
                      <div className="mt-1 flex items-center gap-2.5">
                        {modelView.busy ? (
                          <Spinner className="h-6 w-6 shrink-0 motion-safe:animate-spin text-oro" />
                        ) : (
                          <span
                            className={`h-3 w-3 shrink-0 rounded-full ${
                              modelView.tone === "ok"
                                ? "bg-ok"
                                : modelView.tone === "down"
                                  ? "bg-falla"
                                  : "bg-aviso"
                            }`}
                          />
                        )}
                        <p className="font-display text-3xl font-semibold leading-tight tracking-tight">
                          {modelView.title}
                        </p>
                      </div>
                      <p className="num mt-1.5 max-w-prose text-[15px] text-luz/90">
                        {modelView.detail}
                      </p>
                      {modelView.progress != null && (
                        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-cielo">
                          <div
                            className="h-full rounded-full bg-astro transition-all duration-500 motion-reduce:transition-none"
                            style={{
                              width: `${Math.round(modelView.progress * 100)}%`,
                            }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
                {!loading && isStale(model?.ts) && (
                  <span className="shrink-0 rounded-full bg-aviso/15 px-2 py-0.5 text-xs text-aviso">
                    sin datos recientes
                  </span>
                )}
              </div>

              {!loading && heroTurn && (
                <div className="mt-5 border-t border-linea/70 pt-4">
                  <p className="text-sm text-niebla">
                    {heroIsLive ? "Turno en curso" : "Último turno"} ·{" "}
                    {platformName(heroTurn.platform)} ·{" "}
                    {fmtClock(heroTurn.started_at)}
                    {heroIsLive && heroTurn.total_s != null && (
                      <span className="num">
                        {" "}
                        · lleva {fmtDuration(heroTurn.total_s)}
                      </span>
                    )}
                  </p>
                  <Constellation turn={heroTurn} />
                </div>
              )}
              {!loading && !heroTurn && (
                <p className="mt-5 border-t border-linea/70 pt-4 text-sm text-niebla">
                  Todavía no hay turnos registrados. Aparecen cuando le escribas
                  a Orión.
                </p>
              )}

              {!loading && <ContextBar model={model} />}

              {!loading && cloud && (
                <div className="mt-5 space-y-2 border-t border-linea/70 pt-4 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span className="text-niebla">
                      Respaldo si el modelo local falla
                    </span>
                    <span className="text-luz">
                      {cloud.fallback_chain
                        ? cloud.fallback_chain
                            .split(" → ")
                            .map(shortModel)
                            .join(" → ")
                        : "—"}
                    </span>
                  </div>
                  <p
                    className={`num ${cloud.fallback_count_24h ? "text-aviso" : "text-niebla"}`}
                  >
                    {cloud.fallback_count_24h
                      ? `Se usó ${cloud.fallback_count_24h} ${cloud.fallback_count_24h === 1 ? "vez" : "veces"} en 24 h; la última ${timeAgo(cloud.last_fallback_ts)} (${shortModel(cloud.last_fallback_model)}).`
                      : "No se usó en las últimas 24 h."}
                  </p>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 pt-1">
                    <span className="text-niebla">
                      Resume la conversación con
                    </span>
                    <span className="text-luz">
                      {shortModel(cloud.compression_model)}
                    </span>
                  </div>
                  <p className="num text-niebla">
                    {cloud.compression_count_24h ?? 0} en 24 h
                    {cloud.last_compression_ts &&
                      `; la última tardó ${fmtDuration(cloud.last_compression_s)} (${timeAgo(cloud.last_compression_ts)})`}
                    .
                  </p>
                </div>
              )}
            </section>

            <div className="grid content-start gap-4 min-[700px]:col-start-2 min-[700px]:row-start-1">
              <Section
                title="OpenRouter"
                stale={!loading && isStale(cloud?.ts, 180)}
              >
                {loading ? (
                  <Skeleton />
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-niebla">Saldo</span>
                      <span
                        className={`num font-display text-3xl font-semibold ${lowBalance ? "text-aviso" : "text-oro"}`}
                      >
                        {fmtUsd(cloud?.balance_usd)}
                      </span>
                    </div>
                    <dl className="num grid grid-cols-3 gap-2 border-t border-linea/70 pt-2 text-center">
                      {[
                        ["Hoy", cloud?.spend_day_usd],
                        ["Semana", cloud?.spend_week_usd],
                        ["Mes", cloud?.spend_month_usd],
                      ].map(([label, value]) => (
                        <div key={label as string}>
                          <dt className="text-xs text-niebla">
                            {label as string}
                          </dt>
                          <dd className="text-[15px] text-luz">
                            {fmtUsd(value as number | null | undefined)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className="num text-xs text-niebla">
                      Compresiones hoy: {cloud?.compression_count_24h ?? 0} ·
                      respaldo usado: {cloud?.fallback_count_24h ?? 0}
                    </p>
                    {lowBalance && (
                      <p className="text-xs text-aviso">
                        Saldo bajo: conviene recargar.
                      </p>
                    )}
                  </div>
                )}
              </Section>

              <Section
                title="Recursos del PC"
                stale={!loading && (isStale(gpu?.ts) || isStale(system?.ts))}
              >
                {loading ? (
                  <Skeleton />
                ) : (
                  <div className="space-y-2.5">
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-niebla">GPU</span>
                        <span className="num text-[15px]">
                          <span className="font-display text-lg font-semibold">
                            {gpu?.util_pct != null
                              ? `${Math.round(gpu.util_pct)} %`
                              : "—"}
                          </span>
                          <span
                            className={gpuHot ? "text-falla" : "text-niebla"}
                          >
                            {gpu?.temp_c != null
                              ? ` · ${Math.round(gpu.temp_c)} °C`
                              : ""}
                          </span>
                        </span>
                      </div>
                      <Sparkline values={gpuHist} max={100} tone="#a78bfa" />
                      <p className="num text-xs text-niebla">
                        Video{" "}
                        <span className={vramTight ? "text-aviso" : "text-luz"}>
                          {gb(gpu?.vram_used_mb)} de {gb(gpu?.vram_total_mb)} GB
                        </span>
                        {vramTight && (
                          <span className="text-aviso"> · casi llena</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm text-niebla">CPU</span>
                        <span
                          className={`num font-display text-lg font-semibold ${cpuHigh ? "text-aviso" : ""}`}
                        >
                          {system?.cpu_pct != null
                            ? `${Math.round(system.cpu_pct)} %`
                            : "—"}
                        </span>
                      </div>
                      <Sparkline values={cpuHist} max={100} tone="#6ee7b7" />
                      <p className="num text-xs text-niebla">
                        RAM {gb(system?.ram_used_mb)} de{" "}
                        {gb(system?.ram_total_mb)} GB
                      </p>
                    </div>
                  </div>
                )}
              </Section>
            </div>

            <div className="min-[700px]:col-start-1 min-[700px]:row-start-2">
              <Section title="Últimos turnos">
                {turns.length === 0 ? (
                  <p className="text-sm text-niebla">Sin turnos todavía.</p>
                ) : (
                  <ul className="divide-y divide-linea/60">
                    {turns.map((t) => {
                      const cause = turnCause(t);
                      return (
                        <li key={t.turn_key}>
                          <Fold
                            summary={
                              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                <span className="num text-sm text-niebla">
                                  {fmtClock(t.started_at)}
                                </span>
                                <span className="text-[15px] text-luz">
                                  {platformName(t.platform)}
                                </span>
                                <span
                                  className={`num text-[15px] font-medium ${
                                    t.status === "active"
                                      ? "text-oro"
                                      : t.status === "interrupted"
                                        ? "text-falla"
                                        : "text-luz"
                                  }`}
                                >
                                  {t.status === "active"
                                    ? `en curso · ${fmtDuration(t.total_s)}`
                                    : t.status === "interrupted"
                                      ? `cortado · ${fmtDuration(t.total_s)}`
                                      : fmtDuration(t.total_s)}
                                </span>
                                {cause && (
                                  <span className="text-xs text-aviso">
                                    {cause}
                                  </span>
                                )}
                              </span>
                            }
                          >
                            <PhaseBars t={t} />
                          </Fold>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>
            </div>
          </div>

          <div className="space-y-4 min-[700px]:col-start-2 min-[700px]:row-start-2">
            <div
              className={
                healthIssue ? undefined : "[@media(max-height:500px)]:hidden"
              }
            >
              <Section title="Salud">
                <Fold
                  forceOpen={healthIssue}
                  summary={
                    <span className="flex items-center gap-2.5">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${healthIssue ? "bg-falla" : "bg-ok"}`}
                      />
                      <span className="text-[15px]">
                        {loading
                          ? "Revisando…"
                          : healthIssue
                            ? "Algo no funciona"
                            : "Todo en orden"}
                      </span>
                    </span>
                  }
                >
                  <ul className="space-y-1.5 text-sm">
                    {healthItems.map((h) => (
                      <li
                        key={h.name}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="text-niebla">{h.name}</span>
                        <span className={statusColor(h.status)}>
                          {statusText(h.status)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Fold>
              </Section>
            </div>

            <Section title="Registro técnico">
              <Fold
                summary={
                  <span className="text-[15px] text-niebla">
                    {events.length} eventos recientes
                  </span>
                }
              >
                <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1 text-sm">
                  {events.length === 0 && (
                    <li className="text-niebla">Sin eventos.</li>
                  )}
                  {events.map((e, i) => (
                    <li key={`${e.ts}-${i}`} className="leading-snug">
                      <span className="num text-niebla">{fmtClock(e.ts)}</span>{" "}
                      <span
                        className={
                          e.severity === "error"
                            ? "text-falla"
                            : e.severity === "warn"
                              ? "text-aviso"
                              : "text-luz/90"
                        }
                      >
                        {e.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </Fold>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
