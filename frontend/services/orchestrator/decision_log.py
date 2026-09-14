"""
Decision Audit Log & Explainability Engine for Rakshak 112.
Records why an ambulance/hospital plan was selected, why alternatives were rejected,
and makes every dispatch decision fully transparent for Control Room dispatchers.
"""

import time
from typing import Dict, Any, List, Optional
from .config import ALGORITHM_VERSION

class DecisionLogger:
    def __init__(self):
        # incident_id -> [ decision_record, ... ]
        self.incident_logs: Dict[str, List[Dict[str, Any]]] = {}

    def log_decision(
        self,
        incident_id: str,
        action: str,
        dispatch_plan: Optional[Dict[str, Any]],
        rejected_ambulances: List[Dict[str, Any]] = None,
        rejected_hospitals: List[Dict[str, Any]] = None,
        reason: str = "",
        trigger: str = "AUTO_DISPATCH"
    ) -> Dict[str, Any]:
        """
        Creates and stores a structured explainable decision record.
        """
        now = time.time()
        dec_id = f"DEC-{int(now * 1000 % 1000000):06d}"
        
        record = {
            "decisionId": dec_id,
            "timestamp": int(now * 1000),
            "incidentId": incident_id,
            "action": action,
            "trigger": trigger,
            "reason": reason or ("Plan selected by lowest compliant TTAC" if dispatch_plan else "Evaluation completed"),
            "algorithmVersion": ALGORITHM_VERSION
        }
        
        if dispatch_plan:
            record["dispatchPlanId"] = dispatch_plan.get("dispatchPlanId")
            record["selectedAmbulance"] = {
                "id": dispatch_plan.get("ambulanceId"),
                "driverName": dispatch_plan.get("ambulance", {}).get("driverName"),
                "vehicleNumber": dispatch_plan.get("ambulance", {}).get("vehicleNumber"),
                "type": dispatch_plan.get("ambulance", {}).get("type"),
                "etaMinutes": dispatch_plan.get("responseEtaMinutes")
            }
            record["selectedHospital"] = {
                "id": dispatch_plan.get("hospitalId"),
                "name": dispatch_plan.get("hospital", {}).get("name"),
                "etaMinutes": dispatch_plan.get("transportEtaMinutes"),
                "availableIcu": dispatch_plan.get("hospital", {}).get("availableIcu")
            }
            record["estimatedTTACMinutes"] = dispatch_plan.get("ttacMinutes")
            record["ttacBreakdown"] = dispatch_plan.get("ttacBreakdown")
            record["confidence"] = dispatch_plan.get("confidence")
            record["rationale"] = dispatch_plan.get("rationale", [])
            
        record["rejectedAmbulances"] = rejected_ambulances or []
        record["rejectedHospitals"] = rejected_hospitals or []
        
        logs = self.incident_logs.setdefault(incident_id, [])
        logs.append(record)
        
        return record

    def get_logs(self, incident_id: str) -> List[Dict[str, Any]]:
        return self.incident_logs.get(incident_id, [])

# Singleton
decision_logger = DecisionLogger()
