"""
Escalation & Failure Handling Engine for Rakshak 112.
Never fails silently. Explicitly categorizes unresolvable states and alerts Command Center.
"""

import time
from typing import Dict, Any, List

class EscalationManager:
    def __init__(self):
        # incident_id -> [ escalation_event, ... ]
        self.escalation_records: Dict[str, List[Dict[str, Any]]] = {}

    def trigger_escalation(
        self,
        incident: Dict[str, Any],
        reason_code: str,
        description: str,
        attempted_actions: List[str] = None
    ) -> Dict[str, Any]:
        """
        Escalates an incident to human dispatcher / supervisory command.
        """
        inc_id = incident.get("id")
        now = time.time()
        
        esc_record = {
            "escalationId": f"ESC-{int(now * 1000 % 100000):05d}",
            "incidentId": inc_id,
            "timestamp": int(now * 1000),
            "reasonCode": reason_code,
            "description": description,
            "attemptedActions": attempted_actions or [],
            "status": "REQUIRES_DISPATCHER_INTERVENTION",
            "priority": "HIGH"
        }
        
        records = self.escalation_records.setdefault(inc_id, [])
        records.append(esc_record)
        
        incident["status"] = "ESCALATED"
        incident["state"] = "ESCALATED"
        incident["escalationState"] = esc_record
        
        return esc_record

    def get_escalations(self, incident_id: str) -> List[Dict[str, Any]]:
        return self.escalation_records.get(incident_id, [])

# Singleton
escalation_manager = EscalationManager()
