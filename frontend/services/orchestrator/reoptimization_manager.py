"""
Event-Driven Re-optimization Manager for Rakshak 112.
Evaluates state changes, applies hysteresis (MIN_TTAC_IMPROVEMENT_MINUTES = 3.0),
and becomes increasingly conservative as the patient progresses along the care lifecycle.
"""

import time
from typing import Dict, Any, Tuple
from .config import MIN_TTAC_IMPROVEMENT_MINUTES, REOPTIMIZATION_COOLDOWN_SECONDS

# Hard failure triggers that bypass hysteresis completely
HARD_FAILURE_TRIGGERS = {
    "AMBULANCE_BREAKDOWN",
    "AMBULANCE_OFFLINE",
    "AMBULANCE_REJECTED",
    "HOSPITAL_DIVERTED",
    "HOSPITAL_REJECTED",
    "HOSPITAL_ACK_TIMEOUT",
    "ICU_EXHAUSTED",
    "MANDATORY_CAPABILITY_LOST"
}

class ReoptimizationManager:
    def __init__(self):
        # incident_id -> last_reoptimized_timestamp
        self.last_reopt_times: Dict[str, float] = {}

    def should_reoptimize(
        self,
        incident: Dict[str, Any] = None,
        trigger_event: str = "STATE_CHANGE",
        current_ttac: float = None,
        candidate_ttac: float = None,
        current_plan: Dict[str, Any] = None,
        candidate_plan: Dict[str, Any] = None,
        incident_stage: str = None,
        is_hard_failure: bool = False,
        is_hospital_diverted: bool = False,
        is_ambulance_stalled: bool = False
    ) -> bool:
        """
        Determines whether the active dispatch plan should switch to the candidate plan.
        """
        now = time.time()
        inc_id = (incident or {}).get("id", "INC-CURRENT")
        current_stage = incident_stage or (incident or {}).get("status") or (incident or {}).get("state") or "AMBULANCE_DISPATCHED"
        
        # 1. Hard failure triggers -> IMMEDIATELY bypass hysteresis
        if is_hard_failure or trigger_event in HARD_FAILURE_TRIGGERS or is_hospital_diverted or is_ambulance_stalled:
            self.last_reopt_times[inc_id] = now
            return True

        # Extract TTAC values from plans if provided
        c_ttac = current_ttac if current_ttac is not None else ((current_plan or {}).get("ttacMinutes") or 15.0)
        cand_ttac = candidate_ttac if candidate_ttac is not None else ((candidate_plan or {}).get("ttacMinutes") or 15.0)

        # 2. Lifecycle-Aware Flexibility
        if current_stage in ("AT_HOSPITAL", "HANDOVER_COMPLETE", "INCIDENT_CLOSED"):
            return False, f"Incident already at destination ({current_stage}) -> Reoptimization locked"

        if current_stage == "EN_ROUTE_TO_HOSPITAL":
            # Very conservative when en route to hospital: require >= 5.0 min improvement
            required_improvement = MIN_TTAC_IMPROVEMENT_MINUTES + 2.0
        elif current_stage == "PATIENT_ON_BOARD":
            # Low flexibility when patient is onboard
            required_improvement = MIN_TTAC_IMPROVEMENT_MINUTES + 1.0
        elif current_stage in ("AMBULANCE_EN_ROUTE", "AMBULANCE_DISPATCHED"):
            # Moderate flexibility before patient pickup
            required_improvement = MIN_TTAC_IMPROVEMENT_MINUTES
        else:
            # High flexibility during initial assessment
            required_improvement = 1.5

        # 3. Cooldown check (prevent rapid oscillation)
        last_time = self.last_reopt_times.get(inc_id, 0.0)
        if incident and (now - last_time) < REOPTIMIZATION_COOLDOWN_SECONDS:
            return False

        # 4. Hysteresis TTAC improvement test
        improvement = c_ttac - cand_ttac
        if improvement >= required_improvement:
            self.last_reopt_times[inc_id] = now
            return True
        else:
            return False

# Singleton
reoptimization_manager = ReoptimizationManager()
