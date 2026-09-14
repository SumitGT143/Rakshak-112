"""
Centralized Configuration for Rakshak 112 Dynamic Emergency Orchestrator.
No magic numbers scattered across modules.
"""

# Telemetry and Freshness Thresholds (seconds)
FRESHNESS_LIVE_MAX_SECONDS = 30.0        # < 30s is LIVE
FRESHNESS_RECENT_MAX_SECONDS = 120.0     # 30s - 120s is RECENT
FRESHNESS_STALE_MAX_SECONDS = 900.0      # 2m - 15m is STALE (fallback with low confidence)
HEARTBEAT_TIMEOUT_SECONDS = 300.0        # > 5m without ping is OFFLINE

# GPS & Movement Anomaly Detection
GPS_MAX_ACCURACY_METERS = 100.0          # Reject or flag GPS with accuracy > 100m
MOVEMENT_STALL_THRESHOLD_SECONDS = 180.0 # 3 min without displacement when EN_ROUTE is STALLED
MOVEMENT_MIN_DISTANCE_KM = 0.05          # 50 meters displacement

# Reservation & Lease Timeouts (seconds)
AMBULANCE_RESERVATION_TIMEOUT_SECONDS = 180.0  # 3 minutes lease
HOSPITAL_RESERVATION_TIMEOUT_SECONDS = 300.0   # 5 minutes lease
HOSPITAL_ACK_TIMEOUT_SECONDS = 120.0           # 2 minutes to acknowledge pre-alert

# Re-optimization & Hysteresis Thresholds
MIN_TTAC_IMPROVEMENT_MINUTES = 3.0       # Must improve TTAC by >= 3.0 min for voluntary re-route
REOPTIMIZATION_COOLDOWN_SECONDS = 60.0   # Prevent rapid oscillation

# TTAC Component Delays (minutes)
DEFAULT_SCENE_DELAY_MINUTES = 3.0        # Triage and patient loading
DEFAULT_HANDOVER_DELAY_MINUTES = 2.0     # Emergency bay handover and triage verification

# Algorithm Version
ALGORITHM_VERSION = "RO-2.5-PROD"
