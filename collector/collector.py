#!/usr/bin/env python3
"""Recolector local para hermes-monitor: lee métricas del PC/GPU/modelo/Hermes
y las escribe en Supabase. Nunca sube contenido de mensajes, solo metadata."""

import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
GATEWAY_LOG = Path(os.environ.get("HERMES_GATEWAY_LOG", str(HERMES_HOME / "logs/gateway.log")))
AGENT_LOG = Path(os.environ.get("HERMES_AGENT_LOG", str(HERMES_HOME / "logs/agent.log")))
HERMES_CONFIG = Path(os.environ.get("HERMES_CONFIG", str(HERMES_HOME / "config.yaml")))
LLAMA_HEALTH_URL = os.environ.get("LLAMA_HEALTH_URL", "http://127.0.0.1:8081/health")
LLAMA_METRICS_URL = os.environ.get("LLAMA_METRICS_URL", "http://127.0.0.1:8081/metrics")
LLAMA_SLOTS_URL = os.environ.get("LLAMA_SLOTS_URL", "http://127.0.0.1:8081/slots")
POLL_INTERVAL = float(os.environ.get("COLLECTOR_POLL_INTERVAL", "3"))
CLOUD_POLL_INTERVAL = float(os.environ.get("COLLECTOR_CLOUD_POLL_INTERVAL", "60"))
PENDING_NOTICE_EVERY = 30  # segundos entre avisos de "esperando respuesta"
DEFAULT_COMPRESS_THRESHOLD = 55705

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


def http_get(url: str, headers: dict | None = None, timeout: float = 5) -> str:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode()


# ---------------------------------------------------------------------------
# GPU / sistema
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


# ---------------------------------------------------------------------------
# Turnos: cada mensaje entrante hasta su respuesta, con el desglose de fases
# ---------------------------------------------------------------------------

TURN_STALE_S = 45 * 60


class TurnTracker:
    """Arma cada turno (mensaje -> respuesta) con metadata de los logs y lo publica en la tabla turns."""

    def __init__(self):
        self.active: dict[str, dict] = {}

    def _new(self, platform: str) -> dict:
        started = datetime.now(timezone.utc)
        return {
            "turn_key": f"{platform}:{started.isoformat()}",
            "platform": platform,
            "started_at": started.isoformat(),
            "_t0": time.time(),
            "status": "active",
            "phase": "read",
            "read_s": 0.0,
            "write_s": 0.0,
            "tools_s": 0.0,
            "compress_s": 0.0,
            "api_calls": 0,
            "tokens_in": None,
            "tokens_out": 0,
            "cache_pct": None,
            "tools": {},
            "tool_errors": 0,
            "compressed": False,
            "fallback_used": False,
        }

    def current(self) -> dict | None:
        if not self.active:
            return None
        return max(self.active.values(), key=lambda t: t["_t0"])

    def start(self, platform: str):
        if platform in self.active:
            self._finish(platform, "interrupted")
        self.active[platform] = self._new(platform)
        self._push(self.active[platform])

    def end(self, platform: str, total_s: float):
        turn = self.active.get(platform)
        if turn:
            turn["total_s"] = round(total_s, 1)
            self._finish(platform, "done")

    def interrupt_all(self):
        for platform in list(self.active):
            self._finish(platform, "interrupted")

    def _finish(self, platform: str, status: str):
        turn = self.active.pop(platform)
        turn["status"] = status
        turn["phase"] = None
        turn["ended_at"] = now_iso()
        turn.setdefault("total_s", round(time.time() - turn["_t0"], 1))
        self._push(turn)

    def on_api_call(self, tokens_in: int, tokens_out: int, cache_pct: float | None):
        turn = self.current()
        if turn:
            turn["api_calls"] += 1
            turn["tokens_in"] = tokens_in
            turn["tokens_out"] += tokens_out
            if cache_pct is not None:
                turn["cache_pct"] = cache_pct

    def on_tool(self, name: str, seconds: float, error: bool):
        turn = self.current()
        if turn:
            turn["tools"][name] = turn["tools"].get(name, 0) + 1
            turn["tools_s"] = round(turn["tools_s"] + seconds, 2)
            if error:
                turn["tool_errors"] += 1

    def on_compression(self, seconds: float | None):
        turn = self.current()
        if turn:
            turn["compressed"] = True
            if seconds:
                turn["compress_s"] = round(turn["compress_s"] + seconds, 1)

    def on_fallback(self):
        turn = self.current()
        if turn:
            turn["fallback_used"] = True

    def sample(self, activity: str | None, compressing: bool, dt: float):
        """Suma el tiempo transcurrido a la fase en que está el turno más reciente y publica su estado."""
        turn = self.current()
        if not turn:
            return
        if compressing:
            turn["phase"] = "compress"
        elif activity == "prompt":
            turn["phase"] = "read"
            turn["read_s"] = round(turn["read_s"] + dt, 1)
        elif activity == "generating":
            turn["phase"] = "write"
            turn["write_s"] = round(turn["write_s"] + dt, 1)
        else:
            turn["phase"] = "tools"
        for platform, t in list(self.active.items()):
            if time.time() - t["_t0"] > TURN_STALE_S:
                self._finish(platform, "interrupted")
        if turn["platform"] in self.active:
            turn["total_s"] = round(time.time() - turn["_t0"], 1)
            self._push(turn)

    @staticmethod
    def _push(turn: dict):
        row = {k: v for k, v in turn.items() if not k.startswith("_")}
        row["updated_at"] = now_iso()
        try:
            sb.table("turns").upsert(row, on_conflict="turn_key").execute()
        except Exception as exc:
            print(f"[collector] upsert turn failed: {exc}")


turns = TurnTracker()


# ---------------------------------------------------------------------------
# Modelo local: actividad y velocidades reales medidas entre muestras
# ---------------------------------------------------------------------------

class ModelTracker:
    """Sigue la tarea activa de llama.cpp y calcula tok/s por diferencia entre lecturas de /slots."""

    def __init__(self):
        self.task_id = None
        self.task_start = None
        self.last_t = None
        self.last_decoded = 0
        self.last_done = 0
        self.gen_tok_s = None
        self.prompt_tok_s = None

    def update(self, slot: dict) -> dict:
        now = time.time()
        n_decoded = (slot.get("next_token") or [{}])[0].get("n_decoded", 0) or 0
        prompt_total = slot.get("n_prompt_tokens") or 0
        prompt_done = (slot.get("n_prompt_tokens_cache") or 0) + (slot.get("n_prompt_tokens_processed") or 0)
        prompt_done = min(prompt_done, prompt_total) if prompt_total else prompt_done

        if not slot.get("is_processing"):
            self.task_id = None
            return {"activity": "idle", "gen_tokens": None, "prompt_done": None, "prompt_total": None}

        task_id = slot.get("id_task")
        if task_id != self.task_id:
            self.task_id = task_id
            self.task_start = now
            self.gen_tok_s = None
            self.prompt_tok_s = None
        else:
            dt = now - (self.last_t or now)
            if dt > 0.5:
                d_gen = n_decoded - self.last_decoded
                d_prompt = prompt_done - self.last_done
                if d_gen > 0:
                    self.gen_tok_s = round(d_gen / dt, 2)
                if d_prompt > 0:
                    self.prompt_tok_s = round(d_prompt / dt, 1)
        self.last_t = now
        self.last_decoded = n_decoded
        self.last_done = prompt_done

        activity = "generating" if n_decoded > 0 else "prompt"
        progress = round(min(prompt_done / prompt_total, 1.0), 3) if prompt_total else None
        return {
            "activity": activity,
            "prompt_progress": progress if activity == "prompt" else None,
            "gen_tokens": n_decoded,
            "prompt_done": prompt_done,
            "prompt_total": prompt_total,
            "gen_tok_s": self.gen_tok_s,
            "prompt_tok_s": self.prompt_tok_s,
            "task_elapsed_s": round(now - self.task_start, 1),
        }


model_tracker = ModelTracker()
_last_model_sample = [0.0]


def collect_model(gateway: "GatewayTailer", agent: "AgentTailer") -> None:
    status = "down"
    try:
        body = http_get(LLAMA_HEALTH_URL)
        status = "ok" if '"status":"ok"' in body else "loading"
    except Exception:
        status = "down"

    tok_s = None
    try:
        for line in http_get(LLAMA_METRICS_URL).splitlines():
            if line.startswith("llamacpp:predicted_tokens_seconds"):
                tok_s = float(line.rsplit(" ", 1)[1])
    except Exception:
        pass  # /metrics puede no estar habilitado; status ya quedó seteado

    row = {
        "ts": now_iso(),
        "tok_s": tok_s,
        "status": status,
        "last_response_s": gateway.last_response_s,
        "compress_threshold": agent.compress_threshold,
        **agent.compression_state(),
    }
    try:
        slots = json.loads(http_get(LLAMA_SLOTS_URL))
        if slots:
            slot = slots[0]
            row["ctx_used"] = slot.get("n_prompt_tokens")
            row["ctx_total"] = slot.get("n_ctx")
            row.update(model_tracker.update(slot))
            if row.get("activity") in ("prompt", "generating"):
                gateway.context_cleared = False
            elif gateway.context_cleared:
                row["ctx_used"] = 0
    except Exception:
        pass  # /slots puede no estar habilitado (--no-slots)

    turn_elapsed = gateway.turn_elapsed()
    if turn_elapsed is not None and row.get("activity") in ("prompt", "generating"):
        row["task_elapsed_s"] = turn_elapsed

    insert("model_metrics", row)
    now = time.time()
    dt = now - _last_model_sample[0] if _last_model_sample[0] else 0.0
    _last_model_sample[0] = now
    turns.sample(row.get("activity"), bool(row.get("compress_since")), min(dt, 30.0))
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
# Tail de logs de Hermes -> eventos y estadísticas (sin contenido de mensajes)
# ---------------------------------------------------------------------------

class LogTailer:
    """Sigue un archivo de log con soporte de rotación; `bootstrap` procesa lo ya escrito sin emitir eventos."""

    def __init__(self, path: Path, bootstrap: bool = False):
        self.path = path
        self.bootstrap = bootstrap
        self._fh = None
        self._inode = None

    def _ensure_open(self):
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            return
        if self._fh is None or stat.st_ino != self._inode:
            first_open = self._fh is None
            if self._fh:
                self._fh.close()
            self._fh = open(self.path, "r", errors="replace")
            self._inode = stat.st_ino
            if first_open and self.bootstrap:
                for line in self._fh:
                    self.handle_line(line.rstrip("\n"), live=False)
            elif first_open:
                self._fh.seek(0, os.SEEK_END)

    def poll(self):
        self._ensure_open()
        if self._fh is None:
            return
        for line in self._fh:
            self.handle_line(line.rstrip("\n"), live=True)

    def handle_line(self, line: str, live: bool):
        raise NotImplementedError


INBOUND_RE = re.compile(r"inbound message: platform=(\S+)")
RESPONSE_RE = re.compile(r"response ready: platform=(\S+).*time=([\d.]+)s")
WHATSAPP_PAIR_RE = re.compile(r"WhatsApp enabled but not paired")
TELEGRAM_TIMEOUT_RE = re.compile(r"\[Telegram\].*Timed ?Out", re.IGNORECASE)
COMPACT_START_RE = re.compile(r"Compacting context — summarizing")
COMPACT_TICK_RE = re.compile(r"Compacting context — still summarizing")
GATEWAY_UP_RE = re.compile(r"gateway\.run: ✓ \S+ connected")
SESSION_RESET_RE = re.compile(r"Invalidated run generation .*\(session_reset\)")


class GatewayTailer(LogTailer):
    def __init__(self, path: Path):
        super().__init__(path)
        self.pending_since: dict[str, float] = {}
        self.last_pending_notice = 0.0
        self.last_response_s: float | None = None
        self.context_cleared = False

    def turn_elapsed(self) -> float | None:
        if not self.pending_since:
            return None
        return round(time.time() - min(self.pending_since.values()), 1)

    def poll(self):
        super().poll()
        now = time.time()
        if self.pending_since and now - self.last_pending_notice > PENDING_NOTICE_EVERY:
            for platform, started in self.pending_since.items():
                elapsed = int(now - started)
                if elapsed < PENDING_NOTICE_EVERY:
                    continue
                emit_event(
                    "thinking",
                    f"Orión está pensando en {platform} hace {elapsed}s",
                    severity="warn" if elapsed > 120 else "info",
                )
            self.last_pending_notice = now

    def handle_line(self, line: str, live: bool):
        m = INBOUND_RE.search(line)
        if m:
            self.pending_since[m.group(1)] = time.time()
            turns.start(m.group(1))
            emit_event("inbound", f"Mensaje entrante por {m.group(1)}")
            return

        m = RESPONSE_RE.search(line)
        if m:
            platform, seconds = m.group(1), float(m.group(2))
            self.pending_since.pop(platform, None)
            self.last_response_s = seconds
            turns.end(platform, seconds)
            emit_event("response", f"Orión respondió por {platform} en {seconds:.0f}s")
            return

        if SESSION_RESET_RE.search(line):
            self.context_cleared = True
            return

        if GATEWAY_UP_RE.search(line):
            self.pending_since.clear()
            turns.interrupt_all()
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


LINE_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
FALLBACK_RE = re.compile(r"Fallback activated: .+? → (\S+) \((\w+)\)")
TELEMETRY_RE = re.compile(r"context compression attempt telemetry: (\{.*\})")
THRESHOLD_RE = re.compile(r"threshold=([\d,]+)")
API_CALL_RE = re.compile(r"API call #\d+: .*? in=(\d+) out=(\d+).*?(?:cache=\d+/\d+ \((\d+)%\))?")
TOOL_OK_RE = re.compile(r"tool (\S+) completed \(([\d.]+)s")
TOOL_ERR_RE = re.compile(r"Tool (\S+) returned error \(([\d.]+)s\)")
COMP_STARTED_RE = re.compile(r"context compression started")
COMP_USING_RE = re.compile(r"Auxiliary compression: using (\S+) \(([^)]+)\)")
COMP_DONE_RE = re.compile(
    r"context compression (done|failed|aborted)|Compression made no progress|context compression attempt telemetry|Turn ended"
)
COMPRESSION_STALE_S = 20 * 60


def _line_time(line: str) -> datetime | None:
    m = LINE_TS_RE.match(line)
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").astimezone()


class AgentTailer(LogTailer):
    """Lee agent.log para saber cuándo Orión usa el fallback en la nube y cómo van las compresiones."""

    def __init__(self, path: Path):
        super().__init__(path, bootstrap=True)
        self.fallback_times: list[datetime] = []
        self.last_fallback_model: str | None = None
        self.compression_times: list[datetime] = []
        self.last_compression: dict | None = None
        self.compress_threshold = DEFAULT_COMPRESS_THRESHOLD
        self.compressing_since: datetime | None = None
        self.compressing_model: str | None = None
        self.compressing_provider: str | None = None

    def compression_state(self) -> dict:
        since = self.compressing_since
        if since and (datetime.now().astimezone() - since).total_seconds() > COMPRESSION_STALE_S:
            self.compressing_since = since = None
        return {
            "compress_since": since.isoformat() if since else None,
            "compress_model": self.compressing_model if since else None,
            "compress_provider": self.compressing_provider if since else None,
        }

    def _prune(self):
        cutoff = datetime.now().astimezone() - timedelta(hours=24)
        self.fallback_times = [t for t in self.fallback_times if t >= cutoff]
        self.compression_times = [t for t in self.compression_times if t >= cutoff]

    def stats(self) -> dict:
        self._prune()
        last_c = self.last_compression or {}
        return {
            "fallback_count_24h": len(self.fallback_times),
            "last_fallback_ts": self.fallback_times[-1].isoformat() if self.fallback_times else None,
            "last_fallback_model": self.last_fallback_model,
            "compression_count_24h": len(self.compression_times),
            "last_compression_ts": last_c.get("ts"),
            "last_compression_model": last_c.get("model"),
            "last_compression_provider": last_c.get("provider"),
            "last_compression_s": last_c.get("seconds"),
            "last_compression_tokens": last_c.get("tokens"),
        }

    def handle_line(self, line: str, live: bool):
        m = THRESHOLD_RE.search(line)
        if m:
            self.compress_threshold = int(m.group(1).replace(",", ""))

        if live:
            m = API_CALL_RE.search(line)
            if m:
                turns.on_api_call(int(m.group(1)), int(m.group(2)), float(m.group(3)) if m.group(3) else None)
                return
            m = TOOL_OK_RE.search(line)
            if m:
                turns.on_tool(m.group(1), float(m.group(2)), error=False)
                return
            m = TOOL_ERR_RE.search(line)
            if m:
                turns.on_tool(m.group(1), float(m.group(2)), error=True)
                return

        if COMP_STARTED_RE.search(line):
            self.compressing_since = _line_time(line) or datetime.now().astimezone()
            self.compressing_model = self.compressing_provider = None
            return

        m = COMP_USING_RE.search(line)
        if m and self.compressing_since:
            self.compressing_provider, self.compressing_model = m.group(1), m.group(2)
            return

        if COMP_DONE_RE.search(line):
            self.compressing_since = None

        m = FALLBACK_RE.search(line)
        if m:
            ts = _line_time(line) or datetime.now().astimezone()
            self.fallback_times.append(ts)
            self.last_fallback_model = m.group(1)
            if live:
                turns.on_fallback()
                emit_event("fallback", f"Orión pasó al modelo de respaldo {m.group(1)}", severity="warn")
            return

        m = TELEMETRY_RE.search(line)
        if m:
            try:
                data = json.loads(m.group(1))
            except ValueError:
                return
            if data.get("commit_status") != "committed" or not data.get("aux_model"):
                return
            ts = _line_time(line) or datetime.now().astimezone()
            ms = data.get("aux_call_duration_ms")
            seconds = round(ms / 1000, 1) if ms else None
            self.compression_times.append(ts)
            self.last_compression = {
                "ts": ts.isoformat(),
                "model": data.get("aux_model"),
                "provider": data.get("aux_provider"),
                "seconds": seconds,
                "tokens": data.get("aux_prompt_tokens"),
            }
            if live:
                turns.on_compression(seconds)
                took = f" en {seconds:.0f}s" if seconds is not None else ""
                emit_event("compressed", f"Contexto comprimido con {data.get('aux_model')}{took}")


# ---------------------------------------------------------------------------
# Nube: saldo de OpenRouter y modelos configurados en Hermes
# ---------------------------------------------------------------------------

def _yaml_block(text: str, key: str) -> str:
    """Devuelve las líneas de un bloque de primer nivel del YAML (sin parser completo)."""
    m = re.search(rf"^{re.escape(key)}:\s*\n((?:[ \t-].*\n?|\s*\n)*)", text, re.MULTILINE)
    return m.group(1) if m else ""


def read_cloud_config() -> tuple[str | None, str | None]:
    try:
        text = HERMES_CONFIG.read_text()
    except OSError:
        return None, None
    models = re.findall(r"model:\s*['\"]?([^\s'\"]+)", _yaml_block(text, "fallback_providers"))
    chain = " → ".join(models) if models else None
    aux = _yaml_block(text, "auxiliary")
    comp = re.search(r"compression:\s*\n(?:\s+.*\n)*?\s+model:\s*['\"]?([^\s'\"]+)", aux)
    return chain, comp.group(1) if comp else None


def collect_cloud(agent: AgentTailer) -> None:
    chain, compression_model = read_cloud_config()
    row = {"ts": now_iso(), "fallback_chain": chain, "compression_model": compression_model, **agent.stats()}
    if OPENROUTER_API_KEY:
        headers = {"Authorization": f"Bearer {OPENROUTER_API_KEY}"}
        try:
            key = json.loads(http_get("https://openrouter.ai/api/v1/key", headers, timeout=10)).get("data", {})
            row["spend_day_usd"] = key.get("usage_daily")
            row["spend_week_usd"] = key.get("usage_weekly")
            row["spend_month_usd"] = key.get("usage_monthly")
            row["key_remaining_usd"] = key.get("limit_remaining")
        except Exception as exc:
            print(f"[collector] openrouter key failed: {exc}")
        try:
            credits = json.loads(http_get("https://openrouter.ai/api/v1/credits", headers, timeout=10)).get("data", {})
            if credits.get("total_credits") is not None:
                row["balance_usd"] = round(credits["total_credits"] - credits.get("total_usage", 0), 4)
        except Exception as exc:
            print(f"[collector] openrouter credits failed: {exc}")
    insert("cloud_metrics", row)


def main() -> None:
    gateway = GatewayTailer(GATEWAY_LOG)
    agent = AgentTailer(AGENT_LOG)
    last_slow_poll = 0.0
    last_cloud_poll = 0.0
    print("[collector] starting")
    while True:
        try:
            gateway.poll()
            agent.poll()
            now = time.time()
            if now - last_slow_poll >= POLL_INTERVAL:
                collect_gpu()
                collect_system()
                collect_model(gateway, agent)
                collect_systemd_services()
                last_slow_poll = now
            if now - last_cloud_poll >= CLOUD_POLL_INTERVAL:
                collect_cloud(agent)
                last_cloud_poll = now
        except Exception as exc:
            print(f"[collector] loop error: {exc}")
        time.sleep(2)


if __name__ == "__main__":
    main()
