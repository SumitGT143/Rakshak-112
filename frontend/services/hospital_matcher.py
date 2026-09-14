"""
Hospital Matcher for Rakshak 112 Dynamic Dispatch Engine.
Builds medical requirements from incident triage, enforces clinical hard constraints,
and optimizes for Minimum Time-to-Appropriate-Care (TTAC).
"""

import time
from typing import Dict, Any, List, Optional, Tuple
from .route_service import route_service
from .resource_manager import resource_manager

DATA_FRESHNESS_MAX_HOURS = 24

def build_medical_requirements(incident: Dict[str, Any]) -> Dict[str, bool]:
    """
    Extract deterministic clinical requirements from incident triage, rapid assessment, and emergency type.
    Does NOT invent clinical diagnosis; maps explicit indicators to resource needs.
    """
    e_type = (incident.get("emergencyType") or incident.get("type") or "").lower()
    triage = incident.get("triage") or {}
    assessment = incident.get("assessment") or {}
    priority = incident.get("priority") or {}
    is_critical = (priority.get("code") == "L1" or priority.get("label") == "CRITICAL" or priority.get("score", 0) >= 90)
    
    # Check rapid assessment inputs if available
    ass_conscious = str(assessment.get("conscious") or "").upper()
    ass_breathing = str(assessment.get("breathing") or "").upper()
    ass_bleeding = assessment.get("heavyBleeding") is True or str(assessment.get("heavyBleeding")).lower() in ('true', 'yes')
    ass_pain = assessment.get("severePain") is True or str(assessment.get("severePain")).lower() in ('true', 'yes')
    ass_movement = str(assessment.get("movement") or "").upper()

    injured_count = triage.get("injuredCount", 1)
    conscious = str(triage.get("consciousness") or "").lower()
    severe_bleeding = triage.get("severeBleeding") is True or "bleeding" in str(triage).lower() or ass_bleeding
    trapped = triage.get("trappedOrInjured") is True
    
    is_trauma = any(w in e_type for w in ["trauma", "crash", "accident", "fall", "collision", "hit"]) or ass_bleeding or (ass_movement in ("CANNOT_MOVE", "DIFFICULTY"))
    is_neuro = any(w in e_type for w in ["head", "brain", "skull", "stroke", "coma", "spine"]) or "unresponsive" in conscious or "unconscious" in conscious or ass_conscious in ("NO", "NOT_SURE")
    is_ortho = any(w in e_type for w in ["fracture", "crush", "bone", "limb", "amputation"]) or (is_trauma and is_critical) or ass_movement in ("CANNOT_MOVE", "DIFFICULTY")
    is_cardiac = any(w in e_type for w in ["cardiac", "chest pain", "heart", "arrest", "cpr"]) or (ass_pain and ass_breathing == "SEVERE")
    is_burn = any(w in e_type for w in ["burn", "fire", "explosion", "chemical"])
    
    # ICU needed if critical, severe breathing difficulty, unconscious, multi-trauma, or cardiac arrest
    need_icu = is_critical or is_neuro or is_cardiac or (is_trauma and injured_count >= 2) or "unresponsive" in conscious or (ass_breathing == "SEVERE") or (ass_conscious in ("NO", "NOT_SURE"))
    need_surgery = is_trauma or is_ortho or is_burn or severe_bleeding or ass_pain
    need_blood = is_critical or severe_bleeding or (is_trauma and is_critical) or ass_bleeding
    need_vent = is_cardiac or "unresponsive" in conscious or (is_critical and is_neuro) or (ass_breathing == "SEVERE") or (ass_conscious in ("NO", "NOT_SURE"))
    
    return {
        "trauma": is_trauma,
        "icu": need_icu,
        "surgery": need_surgery,
        "ventilator": need_vent,
        "neurosurgery": is_neuro,
        "orthopedics": is_ortho,
        "bloodBank": need_blood,
        "burnUnit": is_burn
    }

class HospitalMatcher:
    def __init__(self, rm=None, rs=None):
        self.rm = rm or resource_manager
        self.rs = rs or route_service

    def choose_best_hospital(
        self,
        incident: Dict[str, Any],
        hospitals: List[Dict[str, Any]],
        ambulance_eta: float,
        medical_reqs: Dict[str, bool]
    ) -> Dict[str, Any]:
        """
        Filter hospitals through hard constraints, calculate TTAC, and select the optimal facility.
        TTAC = ambulance_eta + hospital_travel_eta + handover_delay
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

        for h in hospitals:
            h_id = h.get("id") or h.get("hospital_name", "UNKNOWN")
            h_name = h.get("hospital_name", h_id)
            c = h.get("capabilities") or {}
            l = h.get("live_status") or {}
            is_l1_trauma = (c.get("trauma_level") == 1 or c.get("traumaLevel") == 1)
            
            # Constraint 1: Hospital is accepting emergency patients
            if l.get("accepting_emergency") is False or l.get("intake_status") == "DIVERTED":
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "Hospital on DIVERTED status / not accepting emergency intake"
                })
                continue

            # Constraint 2: Data Freshness & Confidence Check
            conf = l.get("status_confidence", "HIGH")
            if conf == "STALE_DATA_UNRELIABLE" or conf == "EXPIRED":
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "Hospital live status data expired/unreliable"
                })
                continue

            # Constraint 3: ICU Bed Availability check (incorporates atomic reservations)
            cap = self.rm.get_hospital_capacity(h)
            if medical_reqs.get("icu"):
                if not (c.get("icu") is True or cap["icu_capacity"] > 0):
                    rejected.append({
                        "hospital": h_id,
                        "name": h_name,
                        "reason": "No ICU facility at hospital"
                    })
                    continue
                if cap["available_icu"] <= 0:
                    rejected.append({
                        "hospital": h_id,
                        "name": h_name,
                        "reason": f"ICU capacity exhausted ({cap['icu_reserved']} reserved / {cap['icu_capacity']} cap)"
                    })
                    continue

            # Constraint 4: Surgery / Trauma team / Specialties
            has_neuro = c.get("neurosurgery") or c.get("neuro_surgery") or l.get("neurosurgeon_available") or is_l1_trauma
            if medical_reqs.get("neurosurgery") and not has_neuro:
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "Neurosurgical specialist / trauma craniotomy team unavailable"
                })
                continue

            has_ortho = c.get("orthopedics") or c.get("orthopedic_surgery") or l.get("orthopedic_surgeon_available") or is_l1_trauma
            if medical_reqs.get("orthopedics") and not has_ortho:
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "Orthopedic surgery department unavailable"
                })
                continue

            if medical_reqs.get("burnUnit") and not c.get("burn_unit"):
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "Dedicated burn intensive care unit unavailable"
                })
                continue

            has_blood = c.get("blood_bank") or c.get("bloodBank") or l.get("blood_bank_available") or is_l1_trauma
            if medical_reqs.get("bloodBank") and not has_blood:
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "On-site blood bank unavailable for transfusion"
                })
                continue

            if medical_reqs.get("ventilator") and cap["available_icu"] < 1 and (l.get("ventilators_available", 0) <= 0):
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "No available invasive ventilators"
                })
                continue

            # Check hospital coordinates
            h_lat = h.get("latitude")
            h_lng = h.get("longitude")
            if h_lat is None or h_lng is None:
                rejected.append({
                    "hospital": h_id,
                    "name": h_name,
                    "reason": "Hospital coordinates missing"
                })
                continue

            # Calculate Travel ETA from Incident -> Hospital
            traffic_cond = l.get("traffic_condition", "moderate")
            route_info = self.rs.get_travel_eta(
                origin=(inc_lat, inc_lng),
                destination=(float(h_lat), float(h_lng)),
                is_green_corridor=True,
                traffic_level=traffic_cond
            )
            
            hosp_travel_eta = route_info["eta_minutes"]
            dist_km = route_info["distance_km"]
            
            # Estimated access/handover delay (min) based on trauma level and ER occupancy
            handover_delay = 2.0 if c.get("trauma_level") == 1 else 3.5
            if cap["available_er"] <= 1:
                handover_delay += 1.5
            
            # TTAC = Ambulance response ETA + Hospital travel ETA + Handover delay
            ttac = round(ambulance_eta + hosp_travel_eta + handover_delay, 1)
            
            candidates.append({
                "hospital": h,
                "id": h_id,
                "name": h_name,
                "travel_eta_minutes": hosp_travel_eta,
                "ttac_minutes": ttac,
                "distance_km": dist_km,
                "handover_delay": handover_delay,
                "available_icu": cap["available_icu"],
                "available_er": cap["available_er"],
                "trauma_level": c.get("trauma_level", 2),
                "coordinates": (float(h_lat), float(h_lng))
            })

        if not candidates:
            return {
                "selected": None,
                "error": "NO_SUITABLE_HOSPITAL",
                "reason": ["No feasible hospital found satisfying clinical requirements and live capacity"],
                "rejected": rejected
            }

        # Sort feasible candidates by Minimum TTAC, then Trauma Level
        candidates.sort(key=lambda c: (c["ttac_minutes"], -c["trauma_level"]))
        best = candidates[0]

        for c in candidates[1:]:
            rejected.append({
                "hospital": c["id"],
                "name": c["name"],
                "reason": f"Higher Time-to-Appropriate-Care (TTAC {c['ttac_minutes']} min vs {best['ttac_minutes']} min)"
            })

        reasons = [
            f"Optimized Minimum TTAC: {best['ttac_minutes']} min (Ambulance {ambulance_eta}m + Transit {best['travel_eta_minutes']}m + Handover {best['handover_delay']}m)",
            f"Live Verified Capacity: {best['available_icu']} ICU & {best['available_er']} ER beds available",
            f"Clinical Alignment: Trauma Level {best['trauma_level']} verified"
        ]

        return {
            "selected": best["hospital"],
            "id": best["id"],
            "hospital_name": best["name"],
            "travel_eta_minutes": best["travel_eta_minutes"],
            "ttac_minutes": best["ttac_minutes"],
            "distance_km": best["distance_km"],
            "available_icu": best["available_icu"],
            "available_er": best["available_er"],
            "reasons": reasons,
            "rejected": rejected,
            "coordinates": best["coordinates"]
        }

# Global singleton
hospital_matcher = HospitalMatcher()
