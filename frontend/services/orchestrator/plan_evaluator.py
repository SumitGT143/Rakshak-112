"""
Coordinated Response Plan Evaluator for Rakshak 112.
Evaluates complete paired plans (Ambulance A -> Hospital A, Ambulance A -> Hospital B, etc.).
Rejects invalid combinations and ranks valid plans by minimum TTAC.
"""

import time
from typing import Dict, Any, List, Optional
from .ambulance_selector import ambulance_selector
from .hospital_selector import hospital_selector
from .ttac import calculate_ttac
from .config import DEFAULT_SCENE_DELAY_MINUTES, DEFAULT_HANDOVER_DELAY_MINUTES, ALGORITHM_VERSION

class PlanEvaluator:
    def __init__(self, amb_sel=None, hosp_sel=None):
        self.amb_sel = amb_sel or ambulance_selector
        self.hosp_sel = hosp_sel or hospital_selector

    def evaluate_response_plans(
        self,
        incident: Dict[str, Any],
        responders: List[Dict[str, Any]],
        hospitals: List[Dict[str, Any]],
        medical_reqs: Dict[str, bool]
    ) -> Dict[str, Any]:
        """
        Generates and ranks all feasible paired response plans.
        """
        inc_id = incident.get("id")
        
        # 1. Evaluate ambulances
        feasible_ambs, rejected_ambs = self.amb_sel.evaluate_candidates(incident, responders, medical_reqs)
        
        if not feasible_ambs:
            return {
                "success": False,
                "error": "NO_AMBULANCE_AVAILABLE",
                "message": "No eligible ambulance available meeting hard clinical constraints",
                "rejectedAmbulances": rejected_ambs,
                "rejectedHospitals": []
            }
            
        # 2. Evaluate hospitals
        feasible_hosps, rejected_hosps = self.hosp_sel.evaluate_candidates(incident, hospitals, medical_reqs)
        
        if not feasible_hosps:
            return {
                "success": False,
                "error": "NO_SUITABLE_HOSPITAL",
                "message": "No eligible hospital available meeting emergency clinical requirements",
                "feasibleAmbulances": feasible_ambs,
                "rejectedAmbulances": rejected_ambs,
                "rejectedHospitals": rejected_hosps
            }

        # 3. Generate paired plans: (Amb_i, Hosp_j)
        all_plans = []
        is_critical = medical_reqs.get("isCritical", False)

        for amb in feasible_ambs:
            for hosp in feasible_hosps:
                ttac_res = calculate_ttac(
                    response_eta_minutes=amb["etaMinutes"],
                    transport_eta_minutes=hosp["transitEtaMinutes"],
                    scene_delay_minutes=DEFAULT_SCENE_DELAY_MINUTES,
                    handover_delay_minutes=DEFAULT_HANDOVER_DELAY_MINUTES,
                    is_critical=is_critical
                )
                
                plan_conf = round(amb["confidence"] * hosp["confidence"], 3)
                
                plan_id = f"PLAN-{inc_id}-{amb['id'][:6]}-{hosp['id'][:6]}"
                
                all_plans.append({
                    "dispatchPlanId": plan_id,
                    "ambulance": amb,
                    "hospital": hosp,
                    "ambulanceId": amb["id"],
                    "hospitalId": hosp["id"],
                    "responseEtaMinutes": amb["etaMinutes"],
                    "sceneDelayMinutes": DEFAULT_SCENE_DELAY_MINUTES,
                    "transportEtaMinutes": hosp["transitEtaMinutes"],
                    "handoverDelayMinutes": DEFAULT_HANDOVER_DELAY_MINUTES,
                    "ttacMinutes": ttac_res["ttacMinutes"],
                    "ttacBreakdown": ttac_res["breakdown"],
                    "displaySummary": ttac_res["displaySummary"],
                    "confidence": plan_conf,
                    "algorithmVersion": ALGORITHM_VERSION
                })

        # Rank plans by lowest TTAC, then highest confidence
        all_plans.sort(key=lambda p: (p["ttacMinutes"], -p["confidence"]))
        best_plan = all_plans[0]
        
        # Build explanation rationale
        rationale_points = [
            f"Required medical equipment matched ({best_plan['ambulance']['type']})",
            f"Clinical capabilities satisfied ({best_plan['hospital']['name']})",
            f"Fastest compliant TTAC: {best_plan['ttacMinutes']} min ({best_plan['responseEtaMinutes']}m response + {best_plan['transportEtaMinutes']}m transit)",
            f"High-confidence live telemetry ({int(best_plan['confidence'] * 100)}%)"
        ]

        return {
            "success": True,
            "selectedPlan": best_plan,
            "allCandidatePlans": all_plans,
            "rejectedAmbulances": rejected_ambs,
            "rejectedHospitals": rejected_hosps,
            "rationale": rationale_points,
            "algorithmVersion": ALGORITHM_VERSION
        }

# Singleton
plan_evaluator = PlanEvaluator()
