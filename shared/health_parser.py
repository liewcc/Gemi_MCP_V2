import json
import os
from datetime import datetime

HEALTH_LOG_PATH = "d:/AI/Gemi_MCP_V2/Gemi_Engine_V2/data/session_health.jsonl"

def record_event(provider: str, account: str, status: str, response_time: float, refusal_reason: str = None):
    os.makedirs(os.path.dirname(HEALTH_LOG_PATH), exist_ok=True)
    record = {
        "timestamp": datetime.now().isoformat(),
        "provider": provider,
        "account": account,
        "status": status,
        "response_time": response_time,
        "refusal_reason": refusal_reason
    }
    with open(HEALTH_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

def get_metrics(provider: str = None) -> dict:
    default_stats = {
        "total_attempts": 0,
        "success_rate": 0.0,
        "refusal_rate": 0.0,
        "timeout_rate": 0.0,
        "average_response_time": 0.0
    }
    if not os.path.exists(HEALTH_LOG_PATH):
        return default_stats

    total = 0
    successes = 0
    refusals = 0
    timeouts = 0
    total_time = 0.0

    try:
        with open(HEALTH_LOG_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    if provider and record.get("provider") != provider:
                        continue
                    total += 1
                    status = record.get("status", "").lower()
                    if status == "success":
                        successes += 1
                    elif status == "refused":
                        refusals += 1
                    elif status == "timeout":
                        timeouts += 1
                    total_time += record.get("response_time", 0.0)
                except json.JSONDecodeError:
                    continue
    except Exception:
        return default_stats

    if total == 0:
        return default_stats

    return {
        "total_attempts": total,
        "success_rate": successes / total,
        "refusal_rate": refusals / total,
        "timeout_rate": timeouts / total,
        "average_response_time": total_time / total
    }
