#!/usr/bin/env python3
"""
Chaos Monkey Implementation for Mini-IMDb 3-Tier Distributed System
Simulates stochastic and escalating outages under real concurrent load:
- Runs a background multi-threaded traffic generator hitting Web, API, Cache, and DBs.
- Supports two modes:
  * resilience: single-node (or configurable blast-radius) faults to validate HA.
  * escalate: progressive multi-node faults to locate the exact breaking point
    where the platform goes down, then validates automatic recovery & data integrity.
- Properly restores Keepalived sidecars attached via network_mode: service:<lb>.
- Measures availability, p95 latency, error rate, and MTTR per round.
"""

import argparse
import json
import random
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TARGET_TIERS = {
    "presentation_tier": ["web1", "web2", "web3"],
    "application_tier": ["app1", "app2", "app3"],
    "database_tier": ["galera2", "galera3", "mongo2", "mongo3", "redis-replica"],
    "load_balancers": ["presentation-lb-master", "application-lb-master"],
}

# Sidecars sharing network_mode: "service:<lb>" must be restarted when their LB restarts
SIDECAR_DEPENDENCIES = {
    "presentation-lb-master": ["presentation-keepalived-master"],
    "presentation-lb-backup": ["presentation-keepalived-backup"],
    "application-lb-master": ["application-keepalived-master"],
    "application-lb-backup": ["application-keepalived-backup"],
}

ESCALATION_STAGES = [
    {
        "name": "Nivel 1 - Fallo de 1 nodo Web",
        "tier": "presentation_tier",
        "targets": ["web1"],
    },
    {
        "name": "Nivel 2 - Fallo simultaneo Web + App",
        "tier": "multi_tier",
        "targets": ["web2", "app1"],
    },
    {
        "name": "Nivel 3 - Failover de Balanceador Maestro",
        "tier": "load_balancers",
        "targets": ["presentation-lb-master"],
    },
    {
        "name": "Nivel 4 - Punto de quiebre (capa App agotada)",
        "tier": "application_tier",
        "targets": ["app1", "app2", "app3"],
    },
]


class ConcurrentTrafficGenerator:
    """Sends continuous concurrent HTTP requests in background threads."""

    def __init__(self, host, concurrency=15, worker_delay=0.05):
        self.host = host.rstrip("/")
        self.concurrency = concurrency
        self.worker_delay = worker_delay
        self.endpoints = [
            "/api/movies/top",
            "/api/movies/MOV-001/reviews",
            "/",
        ]
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._samples = []
        self._executor = None
        self._futures = []

    def _worker(self, worker_id):
        idx = worker_id
        while not self._stop_event.is_set():
            endpoint = self.endpoints[idx % len(self.endpoints)]
            idx += 1
            start = time.perf_counter()
            ok = False
            status = 0
            try:
                req = urllib.request.Request(
                    f"{self.host}{endpoint}",
                    headers={"User-Agent": "MiniIMDb-ChaosMonkey/2.0", "Connection": "close"},
                )
                with urllib.request.urlopen(req, timeout=3.0) as resp:
                    status = resp.getcode()
                    resp.read()
                    ok = status == 200
            except Exception as exc:
                status = getattr(exc, "code", 0) or 0
                ok = False

            latency_ms = (time.perf_counter() - start) * 1000.0
            with self._lock:
                self._samples.append((time.time(), ok, status, latency_ms))

            if self.worker_delay > 0:
                self._stop_event.wait(self.worker_delay)

    def start(self):
        self._stop_event.clear()
        self._executor = ThreadPoolExecutor(max_workers=self.concurrency)
        self._futures = [
            self._executor.submit(self._worker, i) for i in range(self.concurrency)
        ]

    def stop(self):
        self._stop_event.set()
        if self._executor:
            self._executor.shutdown(wait=True, cancel_futures=False)

    def reset_window(self):
        with self._lock:
            self._samples.clear()

    def collect_window(self):
        with self._lock:
            data = list(self._samples)
            self._samples.clear()

        total = len(data)
        ok_count = sum(1 for _, ok, _, _ in data if ok)
        fail_count = total - ok_count
        latencies = sorted(lat for _, _, _, lat in data)
        p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0.0
        availability = (ok_count / total) * 100.0 if total > 0 else 0.0
        return {
            "total": total,
            "ok": ok_count,
            "failed": fail_count,
            "availability": availability,
            "p95_ms": p95,
        }


class ChaosMonkey:
    def __init__(
        self,
        host="http://localhost",
        mode="resilience",
        interval=5,
        rounds=4,
        attack_duration=8,
        concurrency=15,
        blast_radius=1,
    ):
        self.host = host.rstrip("/")
        self.mode = mode
        self.interval = interval
        self.rounds = rounds
        self.attack_duration = attack_duration
        self.concurrency = concurrency
        self.blast_radius = max(1, blast_radius)
        self.incidents = []
        self._stopped_targets = set()

    def check_health(self, path="/api/movies/top"):
        try:
            req = urllib.request.Request(
                f"{self.host}{path}",
                headers={"Connection": "close"},
            )
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                return resp.getcode() == 200
        except Exception:
            return False

    def run_cmd(self, cmd):
        try:
            res = subprocess.run(cmd, shell=True, check=True, capture_output=True, text=True)
            return res.stdout.strip()
        except subprocess.CalledProcessError as exc:
            return (exc.stderr or exc.stdout or str(exc)).strip()

    def kill_targets(self, targets):
        joined = " ".join(targets)
        print(f"\n[CHAOS MONKEY ATTACK] -> Deteniendo: {joined}")
        self.run_cmd(f"docker compose stop {joined}")
        self._stopped_targets.update(targets)

    def revive_targets(self, targets):
        if not targets:
            return
        joined = " ".join(targets)
        print(f"[CHAOS MONKEY RECOVERY] -> Restaurando: {joined}")
        self.run_cmd(f"docker compose start {joined}")

        sidecars = []
        for target in targets:
            sidecars.extend(SIDECAR_DEPENDENCIES.get(target, []))
            self._stopped_targets.discard(target)

        if sidecars:
            sidecar_list = " ".join(sidecars)
            print(f"[CHAOS MONKEY RECOVERY] -> Reiniciando sidecars Keepalived: {sidecar_list}")
            self.run_cmd(f"docker compose restart {sidecar_list}")

    def wait_for_recovery(self, timeout=30.0):
        start = time.perf_counter()
        consecutive_ok = 0
        while (time.perf_counter() - start) < timeout:
            if self.check_health("/api/health") and self.check_health("/api/movies/top"):
                consecutive_ok += 1
                if consecutive_ok >= 2:
                    return time.perf_counter() - start
            else:
                consecutive_ok = 0
            time.sleep(0.5)
        return time.perf_counter() - start

    def _pick_random_targets(self):
        all_pairs = [
            (tier, container)
            for tier, containers in TARGET_TIERS.items()
            for container in containers
        ]
        k = min(self.blast_radius, len(all_pairs))
        chosen = random.sample(all_pairs, k)
        tiers = sorted({t for t, _ in chosen})
        targets = [c for _, c in chosen]
        tier_label = tiers[0] if len(tiers) == 1 else "multi_tier"
        return tier_label, targets

    def _classify_impact(self, availability):
        if availability >= 95.0:
            return "RESISTIO"
        if availability >= 50.0:
            return "DEGRADADO"
        return "CAIDA"

    def execute_experiment(self):
        print("===========================================================================")
        print("      INICIANDO EXPERIMENTO DE CHAOS ENGINEERING (MINI-IMDb 3 CAPAS)       ")
        print(
            f"      Modo: {self.mode} | Concurrencia: {self.concurrency} hilos | "
            f"Duracion ataque: {self.attack_duration}s"
        )
        print("===========================================================================")

        print("\n[Fase 1] Verificacion de Hipotesis de Estado Estable (Steady State)...")
        if not self.check_health("/api/health") or not self.check_health("/api/movies/top"):
            print("  [ERROR CRITICO] El sistema no esta saludable antes de iniciar Chaos Monkey.")
            return
        print("  OK Estado estable comprobado: Sistema 100% operativo.")

        traffic = ConcurrentTrafficGenerator(self.host, concurrency=self.concurrency)
        traffic.start()

        try:
            # Linea base breve bajo carga concurrente
            traffic.reset_window()
            time.sleep(3)
            baseline = traffic.collect_window()
            print(
                f"  Linea base bajo carga ({self.concurrency} hilos): "
                f"{baseline['ok']}/{baseline['total']} OK ({baseline['availability']:.1f}%) "
                f"| p95: {baseline['p95_ms']:.1f} ms"
            )

            if self.mode == "escalate":
                plan = [
                    (stage["name"], stage["tier"], stage["targets"])
                    for stage in ESCALATION_STAGES
                ]
            else:
                plan = []
                for r in range(1, self.rounds + 1):
                    tier, targets = self._pick_random_targets()
                    plan.append((f"Ronda {r}/{self.rounds}", tier, targets))

            for idx, (label, tier_name, targets) in enumerate(plan, start=1):
                print(f"\n--- [{idx}/{len(plan)}] {label} ---")
                traffic.reset_window()
                self.kill_targets(targets)

                time.sleep(self.attack_duration)
                metrics = traffic.collect_window()
                verdict = self._classify_impact(metrics["availability"])

                self.revive_targets(targets)
                mttr = self.wait_for_recovery(timeout=30.0)

                incident = {
                    "round": idx,
                    "label": label,
                    "targets": ", ".join(targets),
                    "tier": tier_name,
                    "total": metrics["total"],
                    "ok": metrics["ok"],
                    "failed": metrics["failed"],
                    "availability": metrics["availability"],
                    "p95_ms": metrics["p95_ms"],
                    "mttr_s": mttr,
                    "verdict": verdict,
                }
                self.incidents.append(incident)

                print(
                    f"  Resultado [{verdict}]: {metrics['ok']}/{metrics['total']} OK "
                    f"({metrics['availability']:.1f}%) | p95: {metrics['p95_ms']:.1f} ms | "
                    f"MTTR: {mttr:.2f}s"
                )

                if idx < len(plan):
                    print(f"  Pausa de enfriamiento ({self.interval}s)...")
                    time.sleep(self.interval)

        finally:
            traffic.stop()
            if self._stopped_targets:
                print("\n[CLEANUP] Restaurando contenedores que quedaron detenidos...")
                self.revive_targets(sorted(self._stopped_targets))
                self.wait_for_recovery(timeout=30.0)

        self.verify_data_integrity()
        self.generate_report()

    def verify_data_integrity(self):
        print("\n[Fase 3] Verificacion de Integridad de Datos Post-Caos...")
        try:
            with urllib.request.urlopen(f"{self.host}/api/movies/top", timeout=5.0) as resp:
                movies = json.loads(resp.read().decode("utf-8"))
                print(f"  OK Galera Cluster: {len(movies)} peliculas leidas integramente.")
        except Exception as exc:
            print(f"  ERROR comprobando Galera: {exc}")

        try:
            with urllib.request.urlopen(
                f"{self.host}/api/movies/MOV-001/reviews", timeout=5.0
            ) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                count = len(data.get("reviews", []))
                print(f"  OK MongoDB Replica Set: {count} resenas accesibles para MOV-001.")
        except Exception as exc:
            print(f"  ERROR comprobando MongoDB: {exc}")

        if self.check_health("/api/health"):
            print("  OK Healthcheck global (/api/health): 3 capas operativas.")
        else:
            print("  ERROR: /api/health no respondio 200 tras la recuperacion.")

    def generate_report(self):
        print("\n===========================================================================")
        print("              REPORTE FINAL DE CHAOS ENGINEERING (MINI-IMDb)               ")
        print("===========================================================================")
        total_ok = sum(i["ok"] for i in self.incidents)
        total_fail = sum(i["failed"] for i in self.incidents)
        total = total_ok + total_fail
        overall_avail = (total_ok / total) * 100.0 if total > 0 else 0.0
        avg_mttr = (
            sum(i["mttr_s"] for i in self.incidents) / len(self.incidents)
            if self.incidents
            else 0.0
        )

        print(f"Modo ejecutado:                 {self.mode}")
        print(f"Concurrencia de trafico:        {self.concurrency} hilos simultaneos")
        print(f"Total ataques ejecutados:       {len(self.incidents)}")
        print(f"Solicitudes exitosas (200 OK):  {total_ok}")
        print(f"Solicitudes fallidas:           {total_fail}")
        print(f"Disponibilidad global:          {overall_avail:.2f}%")
        print(f"MTTR promedio:                  {avg_mttr:.2f} s")
        print("\nDetalle por Ronda:")
        print(
            f"{'Rnd':<4} | {'Objetivos':<28} | {'Reqs':<6} | {'Disp.':<7} | "
            f"{'p95(ms)':<8} | {'MTTR':<6} | {'Estado':<10}"
        )
        print("-" * 86)
        for inc in self.incidents:
            print(
                f"{inc['round']:<4} | {inc['targets']:<28} | {inc['total']:<6} | "
                f"{inc['availability']:>5.1f}%  | {inc['p95_ms']:>7.1f}  | "
                f"{inc['mttr_s']:>4.1f}s | {inc['verdict']:<10}"
            )
        print("===========================================================================")


def main():
    parser = argparse.ArgumentParser(
        description="Chaos Monkey con carga concurrente para Mini-IMDb (3 Capas)"
    )
    parser.add_argument("--host", default="http://localhost", help="Host objetivo")
    parser.add_argument(
        "--mode",
        choices=["resilience", "escalate"],
        default="resilience",
        help="resilience: fallos controlados; escalate: sube intensidad hasta punto de quiebre",
    )
    parser.add_argument("--rounds", type=int, default=4, help="Numero de rondas (modo resilience)")
    parser.add_argument("--interval", type=int, default=5, help="Segundos entre rondas")
    parser.add_argument(
        "--attack-duration",
        type=int,
        default=8,
        help="Segundos que permanecen caidos los contenedores por ronda",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=15,
        help="Numero de hilos enviando solicitudes concurrentes",
    )
    parser.add_argument(
        "--blast-radius",
        type=int,
        default=1,
        help="Contenedores simultaneos a detener por ronda (modo resilience)",
    )
    args = parser.parse_args()

    monkey = ChaosMonkey(
        host=args.host,
        mode=args.mode,
        interval=args.interval,
        rounds=args.rounds,
        attack_duration=args.attack_duration,
        concurrency=args.concurrency,
        blast_radius=args.blast_radius,
    )
    monkey.execute_experiment()


if __name__ == "__main__":
    main()
