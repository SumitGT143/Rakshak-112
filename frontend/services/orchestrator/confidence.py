"""
Confidence and Telemetry Freshness Engine for Rakshak 112.
Every critical dynamic data point carries: value, source, updatedAt, confidence.
"""

import time
from typing import Dict, Any, Tuple
from .config import (
    FRESHNESS_LIVE_MAX_SECONDS,
    FRESHNESS_RECENT_MAX_SECONDS,
    FRESHNESS_STALE_MAX_SECONDS,
    HEARTBEAT_TIMEOUT_SECONDS
)

def evaluate_telemetry_freshness(last_updated_timestamp: float) -> Tuple[str, float]:
    """
    Returns (freshness_tier, confidence_score [0.0 - 1.0]).
    Tiers: 'LIVE', 'RECENT', 'STALE', 'UNAVAILABLE' / 'OFFLINE'.
    """
    if not last_updated_timestamp or last_updated_timestamp <= 0:
        return "UNAVAILABLE", 0.0
    
    # Normalize milliseconds to seconds
    ts = float(last_updated_timestamp)
    if ts > 1e11:
        ts /= 1000.0
    
    now = time.time()
    age = max(0.0, now - ts)
    
    if age <= FRESHNESS_LIVE_MAX_SECONDS:
        # 1.0 down to 0.95
        conf = 1.0 - (age / FRESHNESS_LIVE_MAX_SECONDS) * 0.05
        return "LIVE", round(conf, 3)
    elif age <= FRESHNESS_RECENT_MAX_SECONDS:
        # 0.90 down to 0.70
        fraction = (age - FRESHNESS_LIVE_MAX_SECONDS) / (FRESHNESS_RECENT_MAX_SECONDS - FRESHNESS_LIVE_MAX_SECONDS)
        conf = 0.90 - fraction * 0.20
        return "RECENT", round(conf, 3)
    elif age <= FRESHNESS_STALE_MAX_SECONDS:
        # 0.65 down to 0.30
        fraction = (age - FRESHNESS_RECENT_MAX_SECONDS) / (FRESHNESS_STALE_MAX_SECONDS - FRESHNESS_RECENT_MAX_SECONDS)
        conf = 0.65 - fraction * 0.35
        return "STALE", round(conf, 3)
    else:
        return "OFFLINE", 0.10

def build_data_point(value: Any, source: str, updated_at: float = None, confidence: float = None) -> Dict[str, Any]:
    """
    Constructs a standardized dynamic data point envelope.
    """
    now = time.time()
    ts = updated_at if updated_at is not None else now
    
    if confidence is None:
        _, calc_conf = evaluate_telemetry_freshness(ts)
    else:
        calc_conf = confidence
        
    return {
        "value": value,
        "source": source,
        "updatedAt": int(ts * 1000) if ts < 1e11 else int(ts),
        "confidence": round(float(calc_conf), 3)
    }
