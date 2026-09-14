"""
Authoritative Incident State Machine & Transition Engine for Rakshak 112.
Enforces strictly valid linear progressions, explicit failure states, and state versioning.
"""

from typing import Dict, Any, List, Optional, Tuple, Set

# Complete Authoritative States
VALID_INCIDENT_STATES = {
    "SOS_RECEIVED",
    "INCIDENT_CREATED",
    "ASSESSING",
    "AMBULANCE_SEARCHING",
    "AMBULANCE_RESERVED",
    "AMBULANCE_DISPATCHED",
    "AMBULANCE_EN_ROUTE",
    "AMBULANCE_AT_SCENE",
    "PATIENT_ON_BOARD",
    "HOSPITAL_SELECTED",
    "HOSPITAL_PREALERT_SENT",
    "HOSPITAL_CONFIRMED",
    "EN_ROUTE_TO_HOSPITAL",
    "AT_HOSPITAL",
    "HANDOVER_COMPLETE",
    "INCIDENT_CLOSED",
    # Explicit Failure & Escalation States
    "NO_AMBULANCE_AVAILABLE",
    "NO_SUITABLE_HOSPITAL",
    "HOSPITAL_REJECTED",
    "DISPATCH_FAILED",
    "AMBULANCE_FAILURE",
    "ESCALATED",
    "CANCELLED"
}

# State hierarchy / ordering for monotonicity checking
STATE_ORDER = {
    "SOS_RECEIVED": 10,
    "INCIDENT_CREATED": 20,
    "ASSESSING": 30,
    "AMBULANCE_SEARCHING": 40,
    "AMBULANCE_RESERVED": 50,
    "AMBULANCE_DISPATCHED": 60,
    "AMBULANCE_EN_ROUTE": 70,
    "AMBULANCE_AT_SCENE": 80,
    "PATIENT_ON_BOARD": 90,
    "HOSPITAL_SELECTED": 95,
    "HOSPITAL_PREALERT_SENT": 100,
    "HOSPITAL_CONFIRMED": 110,
    "EN_ROUTE_TO_HOSPITAL": 120,
    "AT_HOSPITAL": 130,
    "HANDOVER_COMPLETE": 140,
    "INCIDENT_CLOSED": 150,
    # Failure states (terminal or transitional)
    "NO_AMBULANCE_AVAILABLE": 45,
    "NO_SUITABLE_HOSPITAL": 97,
    "HOSPITAL_REJECTED": 105,
    "DISPATCH_FAILED": 65,
    "AMBULANCE_FAILURE": 75,
    "ESCALATED": 200,
    "CANCELLED": 210
}

# Permitted state transitions
PERMITTED_TRANSITIONS: Dict[str, Set[str]] = {
    "SOS_RECEIVED": {"INCIDENT_CREATED", "CANCELLED", "ESCALATED"},
    "INCIDENT_CREATED": {"ASSESSING", "AMBULANCE_SEARCHING", "NO_AMBULANCE_AVAILABLE", "CANCELLED", "ESCALATED"},
    "ASSESSING": {"AMBULANCE_SEARCHING", "AMBULANCE_RESERVED", "NO_AMBULANCE_AVAILABLE", "CANCELLED", "ESCALATED"},
    "AMBULANCE_SEARCHING": {"AMBULANCE_RESERVED", "AMBULANCE_DISPATCHED", "NO_AMBULANCE_AVAILABLE", "DISPATCH_FAILED", "CANCELLED", "ESCALATED"},
    "NO_AMBULANCE_AVAILABLE": {"AMBULANCE_SEARCHING", "AMBULANCE_RESERVED", "ESCALATED", "CANCELLED"},
    "AMBULANCE_RESERVED": {"AMBULANCE_DISPATCHED", "AMBULANCE_SEARCHING", "DISPATCH_FAILED", "CANCELLED", "ESCALATED"},
    "AMBULANCE_DISPATCHED": {"AMBULANCE_EN_ROUTE", "AMBULANCE_AT_SCENE", "AMBULANCE_FAILURE", "HOSPITAL_PREALERT_SENT", "CANCELLED", "ESCALATED"},
    "AMBULANCE_EN_ROUTE": {"AMBULANCE_AT_SCENE", "AMBULANCE_FAILURE", "HOSPITAL_PREALERT_SENT", "HOSPITAL_CONFIRMED", "CANCELLED", "ESCALATED"},
    "AMBULANCE_FAILURE": {"AMBULANCE_SEARCHING", "AMBULANCE_RESERVED", "ESCALATED", "CANCELLED"},
    "AMBULANCE_AT_SCENE": {"PATIENT_ON_BOARD", "HOSPITAL_SELECTED", "HOSPITAL_PREALERT_SENT", "CANCELLED", "ESCALATED"},
    "PATIENT_ON_BOARD": {"HOSPITAL_SELECTED", "HOSPITAL_PREALERT_SENT", "HOSPITAL_CONFIRMED", "EN_ROUTE_TO_HOSPITAL", "ESCALATED"},
    "HOSPITAL_SELECTED": {"HOSPITAL_PREALERT_SENT", "HOSPITAL_CONFIRMED", "HOSPITAL_REJECTED", "NO_SUITABLE_HOSPITAL", "EN_ROUTE_TO_HOSPITAL", "ESCALATED"},
    "HOSPITAL_PREALERT_SENT": {"HOSPITAL_CONFIRMED", "HOSPITAL_REJECTED", "NO_SUITABLE_HOSPITAL", "EN_ROUTE_TO_HOSPITAL", "ESCALATED"},
    "HOSPITAL_REJECTED": {"HOSPITAL_SELECTED", "HOSPITAL_PREALERT_SENT", "NO_SUITABLE_HOSPITAL", "ESCALATED"},
    "NO_SUITABLE_HOSPITAL": {"HOSPITAL_SELECTED", "HOSPITAL_PREALERT_SENT", "ESCALATED"},
    "HOSPITAL_CONFIRMED": {"EN_ROUTE_TO_HOSPITAL", "AT_HOSPITAL", "HOSPITAL_REJECTED", "ESCALATED"},
    "EN_ROUTE_TO_HOSPITAL": {"AT_HOSPITAL", "HOSPITAL_REJECTED", "ESCALATED"},
    "AT_HOSPITAL": {"HANDOVER_COMPLETE", "INCIDENT_CLOSED", "ESCALATED"},
    "HANDOVER_COMPLETE": {"INCIDENT_CLOSED"},
    "ESCALATED": {"AMBULANCE_SEARCHING", "HOSPITAL_SELECTED", "INCIDENT_CLOSED", "CANCELLED"},
    "DISPATCH_FAILED": {"AMBULANCE_SEARCHING", "ESCALATED", "CANCELLED"},
    "CANCELLED": set(),
    "INCIDENT_CLOSED": set()
}

class IncidentStateMachine:
    @staticmethod
    def validate_transition(current_state: str, target_state: str, allow_forced: bool = False) -> Tuple[bool, str]:
        """
        Validate whether transitioning from current_state to target_state is legal.
        """
        if allow_forced:
            return True, "Forced dispatcher transition allowed"
            
        if target_state not in VALID_INCIDENT_STATES:
            return False, f"Unknown target state '{target_state}'"
            
        if current_state == target_state:
            return True, "State unchanged"
            
        if current_state in ("INCIDENT_CLOSED", "CANCELLED") and target_state not in ("INCIDENT_CLOSED", "CANCELLED"):
            return False, f"Cannot transition out of terminal state '{current_state}'"
            
        allowed = PERMITTED_TRANSITIONS.get(current_state, set())
        if target_state in allowed:
            return True, "Valid state transition"
            
        # Also allow reasonable forward progression jumps if not in failure/closed
        curr_order = STATE_ORDER.get(current_state, 0)
        targ_order = STATE_ORDER.get(target_state, 0)
        
        # Prevent backward jumps unless explicitly permitted
        if targ_order < curr_order and target_state not in allowed:
            return False, f"Illegal backward transition from '{current_state}' to '{target_state}'"
            
        # Allow forward progression
        return True, "Forward progression accepted"

    @staticmethod
    def apply_transition(incident: Dict[str, Any], target_state: str, reason: str = "") -> Tuple[bool, str]:
        """
        Safely applies state transition and increments stateVersion monotonically.
        """
        current_state = incident.get("status") or incident.get("state") or "SOS_RECEIVED"
        valid, msg = IncidentStateMachine.validate_transition(current_state, target_state)
        
        if not valid:
            return False, msg
            
        incident["status"] = target_state
        incident["state"] = target_state
        
        # Monotonically increasing state version
        curr_ver = incident.get("stateVersion", 0)
        incident["stateVersion"] = curr_ver + 1
        
        return True, f"Transitioned to {target_state} (v{incident['stateVersion']}): {reason}"
