#!/usr/bin/env python3
"""Recolector local para hermes-monitor: lee métricas del PC/GPU/modelo/Hermes
y las escribe en Supabase. Nunca sube contenido de mensajes, solo metadata."""

import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
GATEWAY_LOG = Path(os.environ.get("HERMES_GATEWAY_LOG", str(Path.home() / ".hermes/logs/gateway.log")))
LLAMA_HEALTH_URL = os.environ.get("LLAMA_HEALTH_URL", "http://127.0.0.1:8081/health")
LLAMA_METRICS_URL = os.environ.get("LLAMA_METRICS_URL", "http://127.0.0.1:8081/metrics")
LLAMA_SLOTS_URL = os.environ.get("LLAMA_SLOTS_URL", "http://127.0.0.1:8081/slots")
POLL_INTERVAL = float(os.environ.get("COLLECTOR_POLL_INTERVAL", "3"))
PENDING_NOTICE_EVERY = 30  # segundos entre avisos de "esperando respuesta"

sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def insert(table: str, row: dict) -> None:
    try:
        sb.table(table).insert(row).execute()
    except Exception as exc:  # nunca tirar el collector por un fallo de red puntual
        print(f"[collector] insert into {table} failed: {exc}")


def set_service_status(service: str, status: str, detail: str | None = None) -> None:
    insert("service_status", {"ts": now_iso(), "service": service, "status": status, "detail": detail})


def emit_event(kind: str, message: str, severity: str = "info") -> None:
    insert("events", {"ts": now_iso(), "kind": kind, "message": message, "severity": severity})


# ---------------------------------------------------------------------------
# GPU / sistema / modelo
# ---------------------------------------------------------------------------

def collect_gpu() -> None:
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.strip()
        util, vram_used, vram_total, temp, power = [p.strip() for p in out.split(",")]
        insert(
            "gpu_metrics",
            {
                "ts": now_iso(),
                "util_pct": float(util),
                "vram_used_mb": float(vram_used),
                "vram_total_mb": float(vram_total),
                "temp_c": float(temp),
                "power_w": float(power),
            },
        )
    except Exception as exc:
        print(f"[collector] gpu collection failed: {exc}")


def _read_proc_stat():
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    nums = [int(x) for x in parts]
    idle = nums[3] + nums[4]
    total = sum(nums)
    return idle, total


_prev_cpu = _read_proc_stat()


def collect_system() -> None:
    global _prev_cpu
    try:
        idle, total = _read_proc_stat()
        prev_idle, prev_total = _prev_cpu
        d_idle = idle - prev_idle
        d_total = total - prev_total
        cpu_pct = 0.0 if d_total <= 0 else round((1 - d_idle / d_total) * 100, 1)
        _prev_cpu = (idle, total)

        mem_total = mem_avail = None
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem_total = int(line.split()[1]) // 1024
                elif line.startswith("MemAvailable:"):
                    mem_avail = int(line.split()[1]) // 1024
        ram_used = None if mem_total is None or mem_avail is None else mem_total - mem_avail

        insert(
            "system_metrics",
            {"ts": now_iso(), "cpu_pct": cpu_pct, "ram_used_mb": ram_used, "ram_total_mb": mem_total},
        )
    except Exception as exc:
        print(f"[collector] system collection failed: {exc}")


def collect_model() -> None:
    import urllib.request

    status = "down"
    try:
        with urllib.request.urlopen(LLAMA_HEALTH_URL, timeout=5) as resp:
            body = resp.read().decode()
            status = "ok" if '"status":"ok"' in body else "loading"
    except Exception:
        status = "down"

    tok_s = None
    try:
        with urllib.request.urlopen(LLAMA_METRICS_URL, timeout=5) as resp:
            text = resp.read().decode()
        for line in text.splitlines():
            if line.startswith("llamacpp:predicted_tokens_seconds"):
                tok_s = float(line.rsplit(" ", 1)[1])
    except Exception:
        pass  # /metrics puede no estar habilitado; status ya quedó seteado

    ctx_used = None
    ctx_total = None
    try:
        with urllib.request.urlopen(LLAMA_SLOTS_URL, timeout=5) as resp:
            import json

            slots = json.loads(resp.read().decode())
        if slots:
            ctx_used = slots[0].get("n_prompt_tokens")
            ctx_total = slots[0].get("n_ctx")
    except Exception:
        pass  # /slots puede no estar habilitado (--no-slots)

    insert(
        "model_metrics",
        {"ts": now_iso(), "tok_s": tok_s, "ctx_used": ctx_used, "ctx_total": ctx_total, "status": status},
    )
    set_service_status("llm (modelo local)", "ok" if status == "ok" else "warn" if status == "loading" else "down")


def collect_systemd_services() -> None:
    for unit in ("llm.service", "hermes-gateway.service"):
        try:
            out = subprocess.run(
                ["systemctl", "--user", "is-active", unit], capture_output=True, text=True, timeout=5
            ).stdout.strip()
            status = "ok" if out == "active" else "down"
        except Exception:
            status = "down"
        set_service_status(unit, status)


# ---------------------------------------------------------------------------
# Tail de gateway.log -> eventos (sin contenido de mensajes)
# ---------------------------------------------------------------------------

INBOUND_RE = re.compile(r"inbound message: platform=(\S+)")
RESPONSE_RE = re.compile(r"response ready: platform=(\S+).*time=([\d.]+)s")
WHATSAPP_PAIR_RE = re.compile(r"WhatsApp enabled but not paired")
TELEGRAM_TIMEOUT_RE = re.compile(r"\[Telegram\].*Timed ?Out", re.IGNORECASE)
COMPACT_START_RE = re.compile(r"Compacting context — summarizing")
COMPACT_TICK_RE = re.compile(r"Compacting context — still summarizing")


class LogTailer:
    def __init__(self, path: Path):
        self.path = path
        self._fh = None
        self._inode = None
        self.pending_since: dict[str, float] = {}
        self.last_pending_notice = 0.0

    def _ensure_open(self):
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            return
        if self._fh is None or stat.st_ino != self._inode:
            if self._fh:
                self._fh.close()
            self._fh = open(self.path, "r", errors="replace")
            self._fh.seek(0, os.SEEK_END)
            self._inode = stat.st_ino

    def poll(self):
        self._ensure_open()
        if self._fh is None:
            return
        for line in self._fh:
            self._handle_line(line.rstrip("\n"))

        # avisar si hay un turno pendiente hace rato (sin filtrar contenido del mensaje)
        now = time.time()
        if self.pending_since and now - self.last_pending_notice > PENDING_NOTICE_EVERY:
            for platform, started in self.pending_since.items():
                elapsed = int(now - started)
                emit_event(
                    "thinking",
                    f"Orión está pensando en {platform} hace {elapsed}s",
                    severity="warn" if elapsed > 120 else "info",
                )
            self.last_pending_notice = now

    def _handle_line(self, line: str):
        m = INBOUND_RE.search(line)
        if m:
            platform = m.group(1)
            self.pending_since[platform] = time.time()
            emit_event("inbound", f"Mensaje entrante por {platform}")
            return

        m = RESPONSE_RE.search(line)
        if m:
            platform, seconds = m.group(1), float(m.group(2))
            self.pending_since.pop(platform, None)
            emit_event("response", f"Orión respondió por {platform} en {seconds:.0f}s")
            return

        if COMPACT_START_RE.search(line):
            emit_event("compacting", "Compactando contexto (resumiendo conversación larga)", severity="warn")
            return

        if COMPACT_TICK_RE.search(line):
            return  # ya se avisa vía pending_since; evita duplicar cada 60s

        if WHATSAPP_PAIR_RE.search(line):
            emit_event("whatsapp_unpaired", "WhatsApp quedó sin parear", severity="error")
            return

        if TELEGRAM_TIMEOUT_RE.search(line):
            emit_event("telegram_timeout", "Timeout de Telegram (descarga u otra llamada)", severity="warn")
            return


def main() -> None:
    tailer = LogTailer(GATEWAY_LOG)
    last_slow_poll = 0.0
    print("[collector] starting")
    while True:
        try:
            tailer.poll()
            now = time.time()
            if now - last_slow_poll >= POLL_INTERVAL:
                collect_gpu()
                collect_system()
                collect_model()
                collect_systemd_services()
                last_slow_poll = now
        except Exception as exc:
            print(f"[collector] loop error: {exc}")
        time.sleep(2)


if __name__ == "__main__":
    main()
