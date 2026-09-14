"""
Dynamic Constraint-Aware Emergency Dispatch Engine for Rakshak 112.
Seamlessly integrated with the production-grade Emergency Orchestrator.
"""

from typing import Dict, Any, List, Optional, Callable
from .orchestrator import emergency_orchestrator, decision_logger, reservation_manager

class DispatchEngine:
    def __init__(self, rm=None, am=None, hm=None, rs=None, event_broadcaster: Optional[Callable[[str, Any], None]] = None):
        self.orchestrator = emergency_orchestrator
        if event_broadcaster:
            self.orchestrator.broadcast = event_broadcaster

    @property
    def broadcast(self):
        return self.orchestrator.broadcast

    @broadcast.setter
    def broadcast(self, func):
        self.orchestrator.broadcast = func

    def set_datasets(self, hospitals: List[Dict[str, Any]], responders: List[Dict[str, Any]], incidents: List[Dict[str, Any]]):
        self.orchestrator.set_datasets(hospitals, responders, incidents)

    def dispatch_incident(self, incident: Dict[str, Any]) -> Dict[str, Any]:
        res = self.orchestrator.orchestrate_new_incident(incident)
        return res

    def reevaluate_incident(self, incident_id: str, trigger_reason: str = "STATE_CHANGE") -> Dict[str, Any]:
        return self.orchestrator.reevaluate_incident(incident_id, trigger_event=trigger_reason)

    def handle_hospital_ack(self, incident_id: str, hospital_id: str, accepted: bool, reason: str = "") -> Dict[str, Any]:
        return self.orchestrator.handle_hospital_ack(incident_id, hospital_id, accepted, reason)

    def update_responder_telemetry(self, responder_id: str, lat: float, lng: float, speed_kmh: float = 0.0) -> Dict[str, Any]:
        resp = next((r for r in self.orchestrator.responders if (r.get("unit_id") == responder_id or r.get("id") == responder_id)), None)
        if resp:
            telem = resp.setdefault("live_telemetry", {})
            telem["current_latitude"] = lat
            telem["current_longitude"] = lng
            telem["speed_kmh"] = speed_kmh
            import time
            telem["last_ping_timestamp"] = int(time.time() * 1000)
            
            # Find incident
            inc_id = resp.get("assigned_incident")
            if inc_id:
                inc = next((i for i in self.orchestrator.incidents if i.get("id") == inc_id), None)
                if inc:
                    if "assignedAmbulanceDetails" in inc:
                        inc["assignedAmbulanceDetails"]["coordinates"] = {"latitude": lat, "longitude": lng}
                    self.orchestrator._broadcast_incident_event("ambulance:location_updated", {
                        "incident_id": inc_id,
                        "ambulance_id": responder_id,
                        "latitude": lat,
                        "longitude": lng,
                        "speed_kmh": speed_kmh
                    })
            return {"success": True, "responder": resp}
        return {"success": False, "error": "RESPONDER_NOT_FOUND"}

    def get_decision_log(self, incident_id: str) -> List[Dict[str, Any]]:
        return decision_logger.get_logs(incident_id)

# Singleton export
dispatch_engine = DispatchEngine()
