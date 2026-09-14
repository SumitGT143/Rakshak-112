"""
Hospital Candidate Evaluator & Ranker for Rakshak 112.
Applies clinical hard constraints, evaluates real-time bed capacity (accounting for atomic locks),
computes travel transit time from scene to hospital, and records explicit rejection reasons.
"""

import time
from typing import Dict, Any, List, Tuple
from .constraints import ConstraintValidator
from .routing_service import routing_service
from .reservation_manager import reservation_manager
from .confidence import evaluate_telemetry_freshness

class HospitalSelector:
    def __init__(self, rm=None, rs=None):
        self.rm = rm or reservation_manager
        self.rs = rs or routing_service

    def evaluate_candidates(
        self,
        incident: Dict[str, Any],
        hospitals: List[Dict[str, Any]],
        medical_reqs: Dict[str, bool]
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Returns (feasible_candidates, rejected_candidates).
        """
        inc_loc = incident.get("location") or {}
        inc_lat = inc_loc.get("latitude") or incident.get("lat")
        inc_lng = inc_loc.get("longitude") or incident.get("lng")
        
        if inc_lat is None or inc_lng is None:
            return [], [{"id": "ALL", "reason": "INCIDENT_MISSING_GPS"}]

        feasible = []
        rejected = []
        rejected_ids = incident.get("rejectedHospitalsList", [])

        for h in hospitals:
            h_id = h.get("id") or h.get("hospital_name", "UNKNOWN")
            h_name = h.get("name") or h.get("hospital_name", h_id)
            
            if h_id in rejected_ids or h_name in rejected_ids:
                rejected.append({
                    "id": h_id,
                    "name": h_name,
                    "reason": "HOSPITAL_EXPLICITLY_REJECTED_PREALERT"
                })
                continue
            loc = h.get("location") if isinstance(h.get("location"), dict) else {}
            h_lat = h.get("latitude") or h.get("lat") or loc.get("lat") or loc.get("latitude")
            h_lng = h.get("longitude") or h.get("lng") or loc.get("lng") or loc.get("longitude")
            
            if h_lat is None or h_lng is None:
                rejected.append({
                    "id": h_id,
                    "name": h_name,
                    "reason": "MISSING_FACILITY_COORDINATES"
                })
                continue

            # 1. Capacity & availability
            cap = self.rm.get_hospital_capacity(h)
            
            # 2. Hard constraints check
            valid, reasons = ConstraintValidator.validate_hospital(
                hospital=h,
                medical_reqs=medical_reqs,
                available_icu=cap["available_icu"],
                available_er=cap["available_er"]
            )
            
            if not valid:
                rejected.append({
                    "id": h_id,
                    "name": h_name,
                    "reason": "; ".join(reasons)
                })
                continue

            # 3. Route from scene to hospital
            route_res = self.rs.get_travel_eta(
                origin=(inc_lat, inc_lng),
                destination=(h_lat, h_lng),
                traffic_level="moderate"
            )
            
            transit_eta = route_res["eta_minutes"]
            dist_km = route_res["distance_km"]
            
            live_status = h.get("live_status") or {}
            last_ping = live_status.get("last_updated_timestamp") or time.time()
            tier, conf = evaluate_telemetry_freshness(last_ping)
            
            overall_conf = round(conf * route_res["confidence"], 3)
            
            capabilities = h.get("capabilities") or {}
            is_trauma = capabilities.get("trauma_level") == 1 or capabilities.get("traumaLevel") == 1

            feasible.append({
                "hospital": h,
                "id": h_id,
                "name": h_name,
                "address": h.get("address") or loc.get("address") or "Hospital Emergency Intake",
                "coordinates": (h_lat, h_lng),
                "transitEtaMinutes": transit_eta,
                "distanceKm": dist_km,
                "availableIcu": cap["available_icu"],
                "availableEr": cap["available_er"],
                "isTraumaReady": is_trauma,
                "freshnessTier": tier,
                "confidence": overall_conf
            })

        feasible.sort(key=lambda x: (x["transitEtaMinutes"], -x["confidence"]))
        return feasible, rejected

# Singleton
hospital_selector = HospitalSelector()
