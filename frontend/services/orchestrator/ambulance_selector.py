"""
Ambulance Candidate Evaluator & Ranker for Rakshak 112.
Applies hard constraints, computes traffic-aware response ETAs, evaluates telemetry confidence,
and records explicit rejection reasons for non-selected units.
"""

import time
from typing import Dict, Any, List, Tuple
from .constraints import ConstraintValidator
from .routing_service import routing_service
from .reservation_manager import reservation_manager
from .confidence import evaluate_telemetry_freshness

class AmbulanceSelector:
    def __init__(self, rm=None, rs=None):
        self.rm = rm or reservation_manager
        self.rs = rs or routing_service

    def evaluate_candidates(
        self,
        incident: Dict[str, Any],
        responders: List[Dict[str, Any]],
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
        inc_id = incident.get("id")

        for r in responders:
            r_id = r.get("unit_id") or r.get("id", "UNKNOWN")
            driver_name = r.get("driver", {}).get("name") if isinstance(r.get("driver"), dict) else (r.get("driver_name") or "On-Duty Crew")
            v_num = r.get("vehicle_number") or r.get("vehicle_registration") or r_id
            v_type = (r.get("vehicle_type") or r.get("type") or "ALS Ambulance").upper()

            # 1. Hard Constraints validation
            valid, reasons = ConstraintValidator.validate_ambulance(r, medical_reqs)
            if not valid:
                rejected.append({
                    "id": r_id,
                    "name": driver_name,
                    "vehicle": v_num,
                    "reason": "; ".join(reasons)
                })
                continue

            # 2. Reservation check (atomic availability)
            if not self.rm.is_ambulance_available(r, checking_incident_id=inc_id):
                rejected.append({
                    "id": r_id,
                    "name": driver_name,
                    "vehicle": v_num,
                    "reason": "RESOURCE_LOCKED (Unit currently reserved or assigned to another active incident)"
                })
                continue

            # 3. Telemetry & GPS Freshness
            telem = r.get("live_telemetry") or {}
            loc = r.get("location") or {}
            r_lat = telem.get("current_latitude") or loc.get("lat") or loc.get("latitude")
            r_lng = telem.get("current_longitude") or loc.get("lng") or loc.get("longitude")
            
            last_ts = telem.get("last_ping_timestamp") or r.get("last_updated_timestamp") or time.time()
            tier, conf = evaluate_telemetry_freshness(last_ts)
            
            if tier == "OFFLINE":
                rejected.append({
                    "id": r_id,
                    "name": driver_name,
                    "vehicle": v_num,
                    "reason": "HEARTBEAT_LOST (Unit telemetry is offline > 15 minutes)"
                })
                continue

            # 4. Traffic & Route calculation
            traffic_cond = telem.get("traffic_condition", "moderate")
            route_res = self.rs.get_travel_eta(
                origin=(r_lat, r_lng),
                destination=(inc_lat, inc_lng),
                traffic_level=traffic_cond
            )
            
            eta_minutes = route_res["eta_minutes"]
            dist_km = route_res["distance_km"]
            
            # Confidence combined
            overall_conf = round(conf * route_res["confidence"], 3)

            feasible.append({
                "ambulance": r,
                "id": r_id,
                "driverName": driver_name,
                "vehicleNumber": v_num,
                "type": v_type,
                "coordinates": (r_lat, r_lng),
                "etaMinutes": eta_minutes,
                "distanceKm": dist_km,
                "telemetryFreshness": tier,
                "confidence": overall_conf,
                "gpsAccuracy": telem.get("gps_accuracy", 14.0)
            })

        # Sort feasible by lowest ETA
        feasible.sort(key=lambda x: (x["etaMinutes"], -x["confidence"]))
        return feasible, rejected

# Singleton
ambulance_selector = AmbulanceSelector()
