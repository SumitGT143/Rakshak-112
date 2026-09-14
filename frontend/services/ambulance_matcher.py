"""
Ambulance Matcher for Rakshak 112 Dynamic Dispatch Engine.
Applies Hard Constraints first, calculates traffic-aware response ETAs,
and produces explainable selection & rejection logs.
"""

import time
from typing import Dict, Any, List, Optional, Tuple
from .route_service import route_service
from .resource_manager import resource_manager

GPS_MAX_AGE_SECONDS = 900  # 15 minutes max age for valid live telemetry

class AmbulanceMatcher:
    def __init__(self, rm=None, rs=None):
        self.rm = rm or resource_manager
        self.rs = rs or route_service

    def choose_best_ambulance(
        self,
        incident: Dict[str, Any],
        responders: List[Dict[str, Any]],
        medical_reqs: Dict[str, bool]
    ) -> Dict[str, Any]:
        """
        Evaluate all responders, filter out infeasible candidates with clear rejection reasons,
        and select the fastest feasible unit optimizing for response ETA.
        """
        inc_loc = incident.get("location") or {}
        inc_lat = inc_loc.get("latitude") or incident.get("lat")
        inc_lng = inc_loc.get("longitude") or incident.get("lng")
        
        if inc_lat is None or inc_lng is None:
            return {
                "selected": None,
                "error": "NO_INCIDENT_COORDINATES",
                "reason": ["Incident GPS coordinates missing"],
                "rejected": []
            }
        
        candidates = []
        rejected = []
        now = time.time()
        
        is_critical = (incident.get("priority", {}).get("code") == "L1" or
                       incident.get("priority", {}).get("label") == "CRITICAL" or
                       medical_reqs.get("ventilator") or
                       medical_reqs.get("trauma"))

        for r in responders:
            r_id = r.get("unit_id") or r.get("id", "UNKNOWN")
            
            # Constraint 1: Availability
            if not self.rm.is_ambulance_available(r):
                status_str = r.get("status") or r.get("operational_status", "BUSY")
                rejected.append({
                    "unit_id": r_id,
                    "reason": f"Unit status is {status_str} / currently assigned"
                })
                continue
            
            # Constraint 2: GPS Telemetry exists & not excessively stale
            telem = r.get("live_telemetry") or {}
            loc = r.get("location") or {}
            r_lat = telem.get("current_latitude") or loc.get("lat") or loc.get("latitude")
            r_lng = telem.get("current_longitude") or loc.get("lng") or loc.get("longitude")
            
            if r_lat is None or r_lng is None:
                rejected.append({
                    "unit_id": r_id,
                    "reason": "Missing live GPS telemetry coordinates"
                })
                continue
            
            # GPS freshness check
            last_ping = telem.get("last_ping_timestamp") or r.get("last_updated_timestamp")
            if last_ping:
                try:
                    ping_time = float(last_ping)
                    if ping_time > 1e11:  # ms
                        ping_time /= 1000.0
                    if (now - ping_time) > GPS_MAX_AGE_SECONDS:
                        rejected.append({
                            "unit_id": r_id,
                            "reason": f"Stale GPS telemetry (last ping > {int((now-ping_time)/60)} min ago)"
                        })
                        continue
                except Exception:
                    pass

            # Constraint 3: Medical Capability Match
            equip = r.get("equipment") or {}
            v_type = (r.get("vehicle_type") or r.get("type") or "").upper()
            
            if medical_reqs.get("ventilator") and not equip.get("ventilator"):
                rejected.append({
                    "unit_id": r_id,
                    "reason": "Missing required on-board ventilator"
                })
                continue
            
            if is_critical and ("BLS" in v_type and "ALS" not in v_type and not equip.get("ventilator") and not equip.get("defibrillator_aed")):
                rejected.append({
                    "unit_id": r_id,
                    "reason": "BLS unit unsuitable for Level-1 critical/trauma patient (ALS required)"
                })
                continue

            # Calculate Travel ETA with route service
            traffic_cond = telem.get("traffic_condition", "moderate")
            route_info = self.rs.get_travel_eta(
                origin=(r_lat, r_lng),
                destination=(inc_lat, inc_lng),
                is_green_corridor=False,
                traffic_level=traffic_cond
            )
            
            eta = route_info["eta_minutes"]
            dist = route_info["distance_km"]
            
            # Score: primary driver is lowest ETA; bonus for ALS on critical
            als_bonus = 0.5 if (is_critical and "ALS" in v_type) else 0.0
            score = round(max(1.0, 100.0 - (eta * 4.0) + als_bonus * 5.0), 1)
            
            candidates.append({
                "responder": r,
                "unit_id": r_id,
                "driver": r.get("driver", {}).get("name", "Assigned Crew"),
                "eta_minutes": eta,
                "distance_km": dist,
                "vehicle_type": r.get("vehicle_type") or r.get("type") or "ALS Ambulance",
                "score": score,
                "traffic_factor": route_info["traffic_factor"],
                "coordinates": (r_lat, r_lng)
            })

        if not candidates:
            return {
                "selected": None,
                "error": "NO_SUITABLE_AMBULANCE",
                "reason": ["No eligible ambulance found meeting hard clinical and operational constraints"],
                "rejected": rejected
            }

        # Sort feasible candidates by lowest ETA (fastest response), then score
        candidates.sort(key=lambda c: (c["eta_minutes"], -c["score"]))
        best = candidates[0]
        
        # Add rejection logs for other feasible candidates that were slower
        for c in candidates[1:]:
            rejected.append({
                "unit_id": c["unit_id"],
                "reason": f"Higher response ETA ({c['eta_minutes']} min vs {best['eta_minutes']} min)"
            })

        reasons = [
            "Available & Verified Active Telemetry",
            f"Fastest feasible unit — ETA {best['eta_minutes']} min ({best['distance_km']} km)",
            f"Equipped for emergency ({best['vehicle_type']})"
        ]

        return {
            "selected": best["responder"],
            "unit_id": best["unit_id"],
            "driver": best["driver"],
            "eta_minutes": best["eta_minutes"],
            "distance_km": best["distance_km"],
            "vehicle_type": best["vehicle_type"],
            "score": best["score"],
            "reasons": reasons,
            "rejected": rejected,
            "coordinates": best["coordinates"]
        }

# Global singleton
ambulance_matcher = AmbulanceMatcher()
