#!/usr/bin/env python3
"""Checks the VPS stack's files (compose, Caddy, Prometheus, Loki, Alloy, shell scripts).

Each vendor's own validator is used where it is installed (docker compose, caddy, promtool,
loki, alloy, shellcheck) and skipped, with a note, where it is not. The structural checks on the
compose files always run. Exit code 0 when nothing that ran failed.

    python3 tests/harness/check_deploy.py [--tools DIR]

--tools adds DIR to the search path (the binaries do not have to be installed system-wide).
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
args = sys.argv[1:]
if args[:1] == ["--tools"] and len(args) > 1:
    os.environ["PATH"] = f"{args[1]}{os.pathsep}{os.environ['PATH']}"

failures: list[str] = []
skipped: list[str] = []


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


def bad(msg: str) -> None:
    print(f"  FAIL  {msg}")
    failures.append(msg)


def which(*names: str) -> str | None:
    for n in names:
        if shutil.which(n):
            return n
    return None


def run(cmd: list[str], env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env={**os.environ, **(env or {})})


def tool(label: str, binary: str | None, fn) -> None:
    if binary is None:
        skipped.append(label)
        print(f"  skip  {label} (not installed)")
        return
    fn(binary)


COMBOS = {
    "lite": ["compose.yaml"],
    "postgres": ["compose.yaml", "compose.postgres.yaml"],
    "monitoring": ["compose.yaml", "compose.monitoring.yaml"],
    "full": ["compose.yaml", "compose.postgres.yaml", "compose.monitoring.yaml"],
}
ENV = {"POSTGRES_PASSWORD": "abc123", "GRAFANA_ADMIN_PASSWORD": "pw"}

print("compose files")
rendered: dict[str, dict] = {}
compose = ["docker", "compose"] if which("docker") and run(["docker", "compose", "version"]).returncode == 0 else (
    ["docker-compose"] if which("docker-compose") else None
)
if compose is None:
    skipped.append("docker compose config")
    print("  skip  docker compose config (not installed); parsing the YAML only")
for name, files in COMBOS.items():
    if compose:
        cmd = compose + [a for f in files for a in ("-f", f)] + ["config"]
        r = run(cmd, env={**ENV, "COMPOSE_FILE": ""})
        if r.returncode != 0:
            bad(f"{name}: {r.stderr.strip().splitlines()[-1] if r.stderr.strip() else 'config failed'}")
            continue
        rendered[name] = yaml.safe_load(r.stdout)
        ok(f"{name}: config renders")
    else:
        merged: dict = {"services": {}}
        for f in files:
            for k, v in (yaml.safe_load((ROOT / f).read_text()).get("services") or {}).items():
                merged["services"].setdefault(k, {}).update(v)
        rendered[name] = merged

for name, who in (("postgres", "POSTGRES_PASSWORD"), ("monitoring", "GRAFANA_ADMIN_PASSWORD")):
    if compose:
        r = run(compose + [a for f in COMBOS[name] for a in ("-f", f)] + ["config", "-q"], env={"COMPOSE_FILE": ""})
        if r.returncode != 0 and who in r.stderr:
            ok(f"{name}: refuses to start without {who}")
        else:
            bad(f"{name}: a missing {who} must stop the stack")

print("structure")
full = rendered.get("full", {}).get("services", {})
for svc, spec in full.items():
    image = spec.get("image", "")
    local = image.endswith(":local")
    if not local and (":" not in image or image.endswith(":latest")):
        bad(f"{svc}: image {image!r} is not pinned to a version")
    for p in spec.get("ports", []) or []:
        if isinstance(p, dict):
            host_ip, target = p.get("host_ip", ""), p.get("target")
        else:
            # Without docker compose the ports are still strings such as "127.0.0.1:${PORT:-3000}:3000".
            text = str(p)
            host_ip = (re.match(r"(\d+\.\d+\.\d+\.\d+):", text) or [None, ""])[1]
            tail = re.search(r":(\d+)(?:/\w+)?$", text)
            target = int(tail.group(1)) if tail else None
        if svc == "caddy" and target in (80, 443):
            continue
        if host_ip == "127.0.0.1":
            continue
        bad(f"{svc}: publishes {p} to the world; only Caddy may, and Grafana on 127.0.0.1")
    if svc.startswith("init"):
        if spec.get("restart") != "no":
            bad(f"{svc}: a one-shot job must have restart: 'no'")
        continue
    if spec.get("restart") != "unless-stopped":
        bad(f"{svc}: restart policy is {spec.get('restart')!r}, expected unless-stopped")
    if not spec.get("mem_limit"):
        bad(f"{svc}: no memory limit")
    for v in spec.get("volumes", []) or []:
        src = v.get("source", "") if isinstance(v, dict) else str(v).split(":")[0]
        if isinstance(v, dict) and v.get("type") == "tmpfs":
            continue
        inside = str(src).startswith(str(ROOT)) or str(src).startswith(".")
        system = str(src) in ("/", "/var/run/docker.sock")
        if not inside and not system:
            bad(f"{svc}: volume {src!r} is not a folder of this project (nothing may live only in a container)")
    wants_check = svc in ("postgres", "prometheus", "grafana", "alertmanager")
    if wants_check and "healthcheck" not in spec:
        bad(f"{svc}: no health check")
    # The Loki image is distroless: nothing can run inside it to ask, so a health check there is
    # unhealthy for ever (seen in CI), and a service that waits for it never starts.
    if svc == "loki" and "healthcheck" in spec:
        bad("loki: has a health check, but its image has no shell, wget or curl (the container would stay unhealthy)")
    for dep, how in (spec.get("depends_on") or {}).items() if isinstance(spec.get("depends_on"), dict) else []:
        if dep == "loki" and (how or {}).get("condition") != "service_started":
            bad(f"{svc}: depends on loki with condition {(how or {}).get('condition')!r}; loki has no health check, use service_started")
if full and not failures:
    ok(f"{len(full)} services: pinned images, ports, restart, memory limits, bind mounts, health checks")

df = (ROOT / "Dockerfile").read_text()
if df.count("HEALTHCHECK") >= 2:
    ok("Dockerfile: health checks for the server and for Caddy")
else:
    bad("Dockerfile: the server and the web image need a HEALTHCHECK each")
for needle in ("USER node", "ARG NODE_VERSION=", "ARG CADDY_VERSION="):
    ok(f"Dockerfile has {needle}") if needle in df else bad(f"Dockerfile lacks {needle}")
nvmrc = (ROOT / ".nvmrc").read_text().strip().lstrip("v")
node = re.search(r"ARG NODE_VERSION=(\S+)", df)
if node and node.group(1).split(".")[0] == nvmrc.split(".")[0]:
    ok(f"Dockerfile Node {node.group(1)} is on the same major as .nvmrc ({nvmrc})")
else:
    bad(f"Dockerfile Node version {node and node.group(1)} does not match .nvmrc ({nvmrc})")

print("caddy")


def caddy(binary: str) -> None:
    for site in (":80", "play.example.org"):
        r = run([binary, "validate", "--config", "deploy/Caddyfile", "--adapter", "caddyfile"], env={"SITE_ADDRESS": site})
        ok(f"Caddyfile valid for SITE_ADDRESS={site}") if r.returncode == 0 else bad(f"Caddyfile ({site}): {r.stderr.strip()[-200:]}")
    r = run([binary, "fmt", "--diff", "deploy/Caddyfile"])
    ok("Caddyfile is formatted") if r.returncode == 0 else bad("Caddyfile is not formatted (caddy fmt --overwrite deploy/Caddyfile)")


tool("caddy validate", which("caddy"), caddy)

print("prometheus")


def prom(binary: str) -> None:
    for what, cmd in (
        ("config", ["check", "config", "deploy/prometheus/prometheus.yml"]),
        ("rules", ["check", "rules", "deploy/prometheus/rules/tetrizz.yml"]),
        ("rule tests", ["test", "rules", "deploy/prometheus/tests/tetrizz.test.yml"]),
    ):
        r = run([binary, *cmd])
        ok(f"promtool {what}") if r.returncode == 0 else bad(f"promtool {what}: {(r.stdout + r.stderr).strip()[-300:]}")


tool("promtool", which("promtool"), prom)

print("alertmanager")
rules_doc = yaml.safe_load((ROOT / "deploy/prometheus/rules/tetrizz.yml").read_text())
alert_names = {r["alert"] for g in rules_doc["groups"] for r in g["rules"] if "alert" in r}
prom_doc = yaml.safe_load((ROOT / "deploy/prometheus/prometheus.yml").read_text())
routes_doc = yaml.safe_load((ROOT / "deploy/alertmanager/routes.yml").read_text())

targets = [t for am in prom_doc.get("alerting", {}).get("alertmanagers", []) for sc in am.get("static_configs", []) for t in sc.get("targets", [])]
ok("prometheus.yml sends alerts to alertmanager:9093") if targets == ["alertmanager:9093"] else bad(f"prometheus.yml alerting targets are {targets}, expected ['alertmanager:9093']")
scraped = {j["job_name"] for j in prom_doc["scrape_configs"]}
for job in ("loki", "alloy", "alertmanager"):
    ok(f"prometheus.yml scrapes {job}") if job in scraped else bad(f"prometheus.yml does not scrape {job} (MonitoringComponentDown watches it)")
ok("Watchdog and MonitoringComponentDown rules exist") if {"Watchdog", "MonitoringComponentDown"} <= alert_names else bad("rules lack Watchdog or MonitoringComponentDown")

# Every alert name an inhibit rule or a route mentions must be a rule that exists.
mentioned: set[str] = set()
for rule in routes_doc.get("inhibit_rules", []):
    for m in rule.get("source_matchers", []) + rule.get("target_matchers", []):
        for name in re.findall(r"Tetrizz\w+|Host\w+|Watchdog", re.sub(r"^alertname=~?", "", m)):
            mentioned.add(name)
        alt = re.search(r"Tetrizz\(([^)]*)\)", m)
        if alt:
            mentioned.update("Tetrizz" + part for part in alt.group(1).split("|"))
            mentioned.discard("Tetrizz")
mentioned.discard("Tetrizz")
unknown = sorted(mentioned - alert_names)
ok(f"every alert named in routes.yml exists as a rule ({len(mentioned)})") if not unknown else bad(f"routes.yml names alerts that have no rule: {unknown}")
route_names = [r.get("receiver") for r in routes_doc["route"].get("routes", [])]
ok("routes.yml sends Watchdog to the heartbeat receiver only") if route_names[:1] == ["heartbeat"] and "continue" not in routes_doc["route"]["routes"][0] else bad("the first route must send Watchdog to heartbeat without continue")

am_cmd = " ".join(str(c) for c in (rendered.get("monitoring", {}).get("services", {}).get("alertmanager", {}).get("command") or []))
ok("alertmanager runs without clustering (--cluster.listen-address=)") if "--cluster.listen-address=" in am_cmd else bad("alertmanager must run with --cluster.listen-address= (one instance; clustering needs a private address)")


def entrypoint_render(extra: dict[str, str]) -> tuple[subprocess.CompletedProcess, Path]:
    out = Path(tempfile.mkdtemp(prefix="am-"))
    env = {"PATH": os.environ["PATH"], "ALERTMANAGER_RENDER_ONLY": "1", "ALERTMANAGER_RUN_DIR": str(out),
           "ALERTMANAGER_SOURCE_DIR": str(ROOT / "deploy/alertmanager"), **extra}
    return subprocess.run(["sh", str(ROOT / "deploy/alertmanager/entrypoint.sh")], cwd=ROOT, capture_output=True, text=True, env=env), out


SETTINGS = {
    "no integrations": {},
    "telegram": {"ALERT_TELEGRAM_BOT_TOKEN": "123456:ABC-secret", "ALERT_TELEGRAM_CHAT_ID": "-1001234567890"},
    "everything": {"ALERT_TELEGRAM_BOT_TOKEN": "123456:ABC-secret", "ALERT_TELEGRAM_CHAT_ID": "987654321",
                   "ALERT_DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/1/secret-webhook", "ALERT_HEARTBEAT_URL": "https://hc-ping.com/secret-uuid"},
}
rendered_dirs: dict[str, Path] = {}
for label, settings in SETTINGS.items():
    r, out = entrypoint_render(settings)
    if r.returncode != 0:
        bad(f"alertmanager entrypoint ({label}): {r.stderr.strip()}")
        continue
    text = (out / "alertmanager.yml").read_text()
    leaked = [v for v in settings.values() if v in text and v.lstrip("-").isdigit() is False]
    ok(f"alertmanager configuration renders ({label}); no secret in the YAML") if not leaked else bad(f"alertmanager configuration ({label}) contains a secret: {leaked}")
    rendered_dirs[label] = out


def amtool(binary: str) -> None:
    for label, out in rendered_dirs.items():
        r = run([binary, "check-config", str(out / "alertmanager.yml")])
        ok(f"amtool check-config ({label})") if r.returncode == 0 else bad(f"amtool ({label}): {(r.stdout + r.stderr).strip()[-300:]}")
    cfg = str(rendered_dirs["everything"] / "alertmanager.yml") if "everything" in rendered_dirs else None
    if cfg is None:
        return
    for labels, want in (
        (["alertname=Watchdog", "severity=none"], "heartbeat"),
        (["alertname=TetrizzServerDown", "severity=critical"], "owner"),
        (["alertname=HostDiskLow", "severity=warning"], "owner"),
        (["alertname=SomethingNew"], "owner"),
    ):
        r = run([binary, "config", "routes", "test", f"--config.file={cfg}", *labels])
        got = r.stdout.strip()
        ok(f"route {' '.join(labels)} -> {want}") if r.returncode == 0 and got == want else bad(f"route {' '.join(labels)} went to {got!r}, expected {want!r}")


tool("amtool", which("amtool"), amtool)

for label, settings, message in (
    ("a token without a chat id", {"ALERT_TELEGRAM_BOT_TOKEN": "x"}, "ALERT_TELEGRAM_CHAT_ID"),
    ("a chat id that is not a number", {"ALERT_TELEGRAM_BOT_TOKEN": "x", "ALERT_TELEGRAM_CHAT_ID": "me"}, "must be a number"),
    ("a Discord address without https", {"ALERT_DISCORD_WEBHOOK_URL": "http://x"}, "https://"),
):
    r, _ = entrypoint_render(settings)
    ok(f"alertmanager entrypoint refuses {label}") if r.returncode != 0 and message in r.stderr else bad(f"alertmanager entrypoint accepted {label}: {r.stderr.strip()}")

print("loki and alloy")


def loki(binary: str) -> None:
    with tempfile.TemporaryDirectory():
        r = run([binary, "-verify-config", "-config.expand-env=true", "-config.file=deploy/loki/loki.yml"], env={"LOKI_RETENTION": "168h"})
    ok("loki -verify-config") if r.returncode == 0 else bad(f"loki: {(r.stdout + r.stderr).strip()[-300:]}")


def alloy(binary: str) -> None:
    r = run([binary, "validate", "deploy/alloy/config.alloy"])
    ok("alloy validate") if r.returncode == 0 else bad(f"alloy: {(r.stdout + r.stderr).strip()[-300:]}")


tool("loki -verify-config", which("loki", "loki-linux-amd64"), loki)
tool("alloy validate", which("alloy", "alloy-linux-amd64"), alloy)

print("shell scripts")


def shellcheck(binary: str) -> None:
    scripts = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "scripts").glob("*.sh")) + ["tests/harness/check_stack.sh"]
    r = run([binary, "-x", "-s", "bash", *scripts])
    ok(f"shellcheck: {len(scripts)} scripts clean") if r.returncode == 0 else bad(f"shellcheck:\n{r.stdout}")
    r = run([binary, "-s", "sh", "deploy/alertmanager/entrypoint.sh"])
    ok("shellcheck: alertmanager entrypoint (POSIX sh) clean") if r.returncode == 0 else bad(f"shellcheck (entrypoint):\n{r.stdout}")


tool("shellcheck", which("shellcheck"), shellcheck)

print("static hosts")
import json

package = json.loads((ROOT / "package.json").read_text())
vite_out = re.search(r'const outDir = single \? "dist-single" : "(\w+)"', (ROOT / "apps/web/vite.config.ts").read_text())

vercel = json.loads((ROOT / "vercel.json").read_text())
for key, script in (("buildCommand", "build"),):
    if vercel.get(key) == f"npm run {script}" and script in package["scripts"]:
        ok(f"vercel.json {key} runs the root script {script!r}")
    else:
        bad(f"vercel.json {key} {vercel.get(key)!r} must be 'npm run {script}', a script of the root package.json")
if vercel.get("outputDirectory") == f"apps/web/{vite_out and vite_out.group(1)}":
    ok(f"vercel.json outputDirectory is where Vite writes the page ({vercel['outputDirectory']})")
else:
    bad(f"vercel.json outputDirectory {vercel.get('outputDirectory')!r} is not Vite's output folder")
if vercel.get("installCommand") == "npm ci":
    ok("vercel.json installs with npm ci (the lock file decides the versions)")
else:
    bad("vercel.json installCommand must be npm ci")
vercel_rules = {r["source"]: {h["key"]: h["value"] for h in r["headers"]} for r in vercel.get("headers", [])}
for source, headers in vercel_rules.items():
    if "immutable" in headers.get("Cache-Control", "") and not source.startswith("/assets/"):
        bad(f"vercel.json: {source} is marked immutable; only the hashed files in /assets may be")

cf: dict[str, dict[str, str]] = {}
current = None
for line in (ROOT / "deploy/cloudflare/_headers").read_text().splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    if not line.startswith((" ", "\t")):
        current = line.strip()
        cf[current] = {}
    elif current is not None:
        name, _, value = line.strip().partition(":")
        cf[current][name.strip()] = value.strip()
    else:
        bad(f"deploy/cloudflare/_headers: header line before any path: {line!r}")
for source, headers in cf.items():
    if "immutable" in headers.get("Cache-Control", "") and not source.startswith("/assets/"):
        bad(f"_headers: {source} is marked immutable; only the hashed files in /assets may be")
if all(v for h in cf.values() for v in h.values()) and cf:
    ok(f"deploy/cloudflare/_headers: {len(cf)} path rules, every header has a value")
else:
    bad("deploy/cloudflare/_headers: empty file or a header without a value")

caddy_text = (ROOT / "deploy/Caddyfile").read_text()
caddy_headers = dict(re.findall(r"^\t\t(X-Content-Type-Options|X-Frame-Options|Referrer-Policy) (\S+)$", caddy_text, re.M))
if caddy_headers and all(vercel_rules.get("/(.*)", {}).get(k) == v for k, v in caddy_headers.items()) and all(
    cf.get("/*", {}).get(k) == v for k, v in caddy_headers.items()
):
    ok("Vercel and Cloudflare send the same security headers as the Caddyfile")
else:
    bad("the security headers of vercel.json, _headers and the Caddyfile differ")

pages = yaml.safe_load((ROOT / ".github/workflows/pages.yml").read_text())
uses = [step["uses"] for job in pages["jobs"].values() for step in job["steps"] if "uses" in step]
floating = [u for u in uses if not re.search(r"@v\d+(\.\d+)*$", u)]
ok(f"pages.yml: {len(uses)} actions, each pinned to a major version") if not floating else bad(f"pages.yml: not pinned to a version: {floating}")
setup_node = next(step for step in pages["jobs"]["build"]["steps"] if step.get("uses", "").startswith("actions/setup-node"))
if setup_node["with"].get("node-version-file") == ".nvmrc":
    ok("pages.yml uses the Node version of .nvmrc")
else:
    bad("pages.yml must take its Node version from .nvmrc")
upload = next(step for step in pages["jobs"]["build"]["steps"] if step.get("uses", "").startswith("actions/upload-pages-artifact"))
if upload["with"]["path"] == vercel.get("outputDirectory"):
    ok(f"pages.yml publishes {upload['with']['path']}, the same folder Vercel does")
else:
    bad("pages.yml publishes a different folder than the build writes")
deploy_job = pages["jobs"]["deploy"]
if deploy_job["permissions"] == {"pages": "write", "id-token": "write"} and deploy_job["environment"]["name"] == "github-pages":
    ok("pages.yml deploy job: pages and id-token write, environment github-pages")
else:
    bad("pages.yml deploy job needs permissions pages: write and id-token: write and the github-pages environment")
passed = (ROOT / ".github/workflows/pages.yml").read_text()
names = re.findall(r"TETRIZZ_[A-Z_]+", (ROOT / ".env.example").read_text())
missing = [n for n in dict.fromkeys(names) if f"{n}: ${{{{ vars.{n} }}}}" not in passed]
if not missing:
    ok(f"pages.yml passes all {len(set(names))} TETRIZZ_ settings of .env.example to the build")
else:
    bad(f"pages.yml does not pass {missing} to the build")

print()
if skipped:
    print(f"skipped: {', '.join(skipped)}")
if failures:
    print(f"{len(failures)} problem(s)")
    sys.exit(1)
print("all checks that ran passed")
