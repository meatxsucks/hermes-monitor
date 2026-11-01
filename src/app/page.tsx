"use client";

import { useEffect, useState } from "react";
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

function timeAgo(ts: string | undefined) {
  if (!ts) return "sin datos";
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
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

function Card({
  title,
  stale,
  children,
}: {
  title: string;
  stale?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">{title}</h2>
        {stale && (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
            sin datos recientes
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export default function Home() {
  const [gpu, setGpu] = useState<GpuRow>();
  const [system, setSystem] = useState<SystemRow>();
  const [model, setModel] = useState<ModelRow>();
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [gpuRes, sysRes, modelRes, svcRes, evtRes] = await Promise.all([
        supabase.from("gpu_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("system_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("model_metrics").select("*").order("ts", { ascending: false }).limit(1),
        supabase.from("service_status").select("*").order("ts", { ascending: false }).limit(10),
        supabase.from("events").select("*").order("ts", { ascending: false }).limit(20),
      ]);
      if (cancelled) return;
      setGpu(gpuRes.data?.[0]);
      setSystem(sysRes.data?.[0]);
      setModel(modelRes.data?.[0]);

      const latestByService = new Map<string, ServiceRow>();
      for (const row of (svcRes.data ?? []) as ServiceRow[]) {
        if (!latestByService.has(row.service)) latestByService.set(row.service, row);
      }
      setServices(Array.from(latestByService.values()));
      setEvents((evtRes.data ?? []) as EventRow[]);
    }

    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 px-4 py-6 text-zinc-100">
      <h1 className="mb-6 text-xl font-semibold">✦ Hermes Stars</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Modelo local" stale={isStale(model?.ts)}>
          <p className="text-2xl font-bold">
            {model?.tok_s != null ? `${model.tok_s.toFixed(1)} tok/s` : "—"}
          </p>
          <p className="text-sm text-zinc-400">
            Contexto: {model?.ctx_used ?? "—"} / {model?.ctx_total ?? "—"}
          </p>
          <p className="text-sm text-zinc-400">Estado: {model?.status ?? "desconocido"}</p>
          <p className="mt-1 text-xs text-zinc-500">{timeAgo(model?.ts)}</p>
        </Card>

        <Card title="GPU" stale={isStale(gpu?.ts)}>
          <p className="text-2xl font-bold">{gpu?.util_pct != null ? `${gpu.util_pct}%` : "—"}</p>
          <p className="text-sm text-zinc-400">
            VRAM: {gpu?.vram_used_mb ?? "—"} / {gpu?.vram_total_mb ?? "—"} MB
          </p>
          <p className="text-sm text-zinc-400">
            {gpu?.temp_c != null ? `${gpu.temp_c}°C` : "—"} ·{" "}
            {gpu?.power_w != null ? `${gpu.power_w}W` : "—"}
          </p>
          <p className="mt-1 text-xs text-zinc-500">{timeAgo(gpu?.ts)}</p>
        </Card>

        <Card title="PC (CPU / RAM)" stale={isStale(system?.ts)}>
          <p className="text-2xl font-bold">
            {system?.cpu_pct != null ? `${system.cpu_pct}% CPU` : "—"}
          </p>
          <p className="text-sm text-zinc-400">
            RAM: {system?.ram_used_mb ?? "—"} / {system?.ram_total_mb ?? "—"} MB
          </p>
          <p className="mt-1 text-xs text-zinc-500">{timeAgo(system?.ts)}</p>
        </Card>

        <Card title="Servicios" stale={services.length === 0}>
          <ul className="space-y-1 text-sm">
            {services.length === 0 && <li className="text-zinc-500">sin datos</li>}
            {services.map((s) => (
              <li key={s.service} className="flex items-center justify-between">
                <span>{s.service}</span>
                <span
                  className={
                    s.status === "ok"
                      ? "text-emerald-400"
                      : s.status === "warn"
                        ? "text-amber-400"
                        : "text-red-400"
                  }
                >
                  {s.status}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Eventos en vivo" stale={events.length === 0}>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
            {events.length === 0 && <li className="text-zinc-500">sin eventos</li>}
            {events.map((e, i) => (
              <li key={i} className="border-b border-zinc-800 pb-1 last:border-0">
                <span className="text-zinc-500">{timeAgo(e.ts)}</span> — {e.message}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
