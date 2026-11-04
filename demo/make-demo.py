#!/usr/bin/env python3
"""Writes a demo folder for the screenshot: made-up agents, transcripts dated today,
and account limits. Point the mod at it with ~/.config/herdr-app/claude-usage.json:

    { "demo": "/path/to/demo-folder" }

Delete that file (or the "demo" key) to go back to your own data.
"""
import json, os, random, sys, uuid
from datetime import datetime, timedelta, timezone

out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "demo-data")
random.seed(7)
now = datetime.now(timezone.utc)
local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)

AGENTS = [
    ("t3", "Refactor auth middleware", "api", "auth", "working", "claude-opus-5-5", 260, 1),
    ("t4", "Migration for the orders table", "api", "db", "blocked", "claude-opus-5-5", 90, 0),
    ("t7", "Fix flaky checkout test", "web", "tests", "done", "claude-sonnet-5-5", 140, 0),
    ("t9", "Review PR #482", "web", "review", "idle", "claude-fable-5-1", 45, 0),
    ("t12", "Profile the image pipeline", "media", "perf", "working", "claude-opus-5-5", 180, 2),
]
OTHER = [("claude-opus-5-5", 120), ("claude-haiku-5-5", 60)]  # sessions outside Herdr

def line(sid, model, ts):
    context = random.randint(40_000, 260_000)
    write = random.randint(800, 9_000)
    usage = {
        "input_tokens": random.randint(1, 12),
        "cache_creation_input_tokens": write,
        "cache_read_input_tokens": context,
        "output_tokens": random.randint(150, 4_500),
        "cache_creation": {"ephemeral_1h_input_tokens": write, "ephemeral_5m_input_tokens": 0},
        "service_tier": "standard", "speed": "standard",
    }
    msg = {"model": model, "id": "msg_demo" + uuid.uuid4().hex[:20], "type": "message", "role": "assistant",
           "content": [{"type": "text", "text": "Demo reply."}], "stop_reason": "end_turn", "usage": usage}
    rec = {"parentUuid": str(uuid.uuid4()), "isSidechain": False, "message": msg, "requestId": "req_demo",
           "type": "assistant", "uuid": str(uuid.uuid4()), "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z",
           "sessionId": sid, "cwd": "/home/demo/project"}
    return json.dumps(rec, separators=(",", ":"))

def transcript(path, sid, model, n):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    start = max(local_midnight.astimezone(timezone.utc), now - timedelta(hours=9))
    span = (now - start).total_seconds() - 60
    stamps = sorted(start + timedelta(seconds=random.uniform(0, span)) for _ in range(n))
    with open(path, "w") as f:
        for ts in stamps:
            f.write(line(sid, model, ts) + "\n")

proj = os.path.join(out, "projects", "-home-demo-project")
agents = []
for addr, title, space, tab, status, model, n, subs in AGENTS:
    sid = str(uuid.uuid4())
    transcript(os.path.join(proj, sid + ".jsonl"), sid, model, n)
    for i in range(subs):
        transcript(os.path.join(proj, sid, "subagents", f"agent-demo-{i}.jsonl"), sid, "claude-sonnet-5-5", n // 2)
    agents.append({"address": addr, "title": title, "space_name": space, "tab_name": tab, "status": status, "session": sid})
for model, n in OTHER:
    sid = str(uuid.uuid4())
    transcript(os.path.join(proj, sid + ".jsonl"), sid, model, n)

def at(hours):
    return (now + timedelta(hours=hours)).isoformat()

quota = {
    "five_hour": {"utilization": 86.0, "resets_at": at(1.6)},
    "seven_day": {"utilization": 41.0, "resets_at": at(4 * 24 + 7)},
    "limits": [{"kind": "weekly_scoped", "percent": 96, "resets_at": at(4 * 24 + 7),
                "scope": {"model": {"display_name": "Fable"}}}],
}
with open(os.path.join(out, "agents.json"), "w") as f:
    json.dump(agents, f, indent=1)
with open(os.path.join(out, "quota.json"), "w") as f:
    json.dump(quota, f, indent=1)
print(out)
