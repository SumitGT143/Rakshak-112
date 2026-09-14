"""
Clinical & Operational Hard Constraint Evaluator for Rakshak 112.
Ensures no resource is ever chosen merely because of distance if it violates mandatory clinical or operational requirements.
"""

from typing import Dict, Any, List, Tuple

def extract_medical_requirements(incident: Dict[str, Any]) -> Dict[str, bool]:
    """
    Extract deterministic medical needs from emergency triage, symptoms, and priority.
    """
    e_type = (incident.get("emergencyType") or incident.get("type") or "").lower()
    triage = incident.get("triage") or {}
    priority = incident.get("priority") or {}
    
    is_critical = (
        priority.get("code") == "L1" or
        priority.get("label") == "CRITICAL" or
        priority.get("score", 0) >= 90
    )
    
    injured_count = triage.get("injuredCount", 1)
    conscious = str(triage.get("consciousness") or "").lower()
    severe_bleeding = triage.get("severeBleeding") is True or "bleeding" in str(triage).lower()
    
    is_trauma = any(w in e_type for w in ["trauma", "crash", "accident", "fall", "collision", "hit", "pedestrian"])
    is_neuro = any(w in e_type for w in ["head", "brain", "skull", "stroke", "coma", "spine"]) or "unresponsive" in conscious or "unconscious" in conscious
    is_ortho = any(w in e_type for w in ["fracture", "crush", "bone", "limb", "amputation"]) or (is_trauma and is_critical)
    is_cardiac = any(w in e_type for w in ["cardiac", "chest pain", "heart", "arrest", "cpr", "myocardial"])
    is_burn = any(w in e_type for w in ["burn", "fire", "explosion", "chemical", "electrocution"])
    
    need_icu = is_critical or is_neuro or is_cardiac or (is_trauma and injured_count >= 2) or "unresponsive" in conscious
    need_surgery = is_trauma or is_ortho or is_burn or severe_bleeding
    need_blood = is_critical or severe_bleeding or (is_trauma and is_critical)
    need_vent = is_cardiac or "unresponsive" in conscious or (is_critical and is_neuro)
    
    return {
        "trauma": is_trauma,
        "icu": need_icu,
        "surgery": need_surgery,
        "ventilator": need_vent,
        "neurosurgery": is_neuro,
        "orthopedics": is_ortho,
        "bloodBank": need_blood,
        "burnUnit": is_burn,
        "isCritical": is_critical
    }

class ConstraintValidator:
    @staticmethod
    def validate_ambulance(ambulance: Dict[str, Any], medical_reqs: Dict[str, bool]) -> Tuple[bool, List[str]]:
        """
        Validate ambulance against operational & clinical constraints.
        """
        rejections = []
        equip = ambulance.get("equipment") or {}
        v_type = (ambulance.get("vehicle_type") or ambulance.get("type") or "").upper()
        
        # 1. Operational status
        status = (ambulance.get("status") or ambulance.get("operational_status") or "AVAILABLE").upper()
        if status not in ("AVAILABLE", "IDLE"):
            rejections.append(f"Ambulance is currently in {status} status")
            
        # 2. Critical care / equipment capability
        equip = ambulance.get("equipment") or {}
        caps = ambulance.get("capabilities") or []
        if isinstance(caps, list):
            has_vent = "ventilator" in [str(x).lower() for x in caps] or equip.get("ventilator")
            has_aed = any(x in [str(k).lower() for k in caps] for x in ["aed", "defibrillator", "defibrillator_aed"]) or equip.get("defibrillator_aed")
        elif isinstance(caps, dict):
            has_vent = equip.get("ventilator") or caps.get("ventilator")
            has_aed = equip.get("defibrillator_aed") or caps.get("defibrillator_aed") or caps.get("aed")
        else:
            has_vent = equip.get("ventilator")
            has_aed = equip.get("defibrillator_aed")

        if medical_reqs.get("ventilator") and not has_vent:
            rejections.append("Missing required on-board ventilator for patient airway support")
            
        if medical_reqs.get("isCritical") and ("BLS" in v_type and "ALS" not in v_type and not has_vent and not has_aed):
            rejections.append("BLS unit lacks ALS resuscitation equipment for Level-1 critical patient")
            
        # 3. GPS Coordinates existence
        telem = ambulance.get("live_telemetry") or {}
        loc = ambulance.get("location") or {}
        lat = telem.get("current_latitude") or loc.get("lat") or loc.get("latitude")
        lng = telem.get("current_longitude") or loc.get("lng") or loc.get("longitude")
        
        if lat is None or lng is None:
            rejections.append("Missing GPS coordinates for unit")
            
        return (len(rejections) == 0), rejections

    @staticmethod
    def validate_hospital(hospital: Dict[str, Any], medical_reqs: Dict[str, bool], available_icu: int, available_er: int) -> Tuple[bool, List[str]]:
        """
        Validate hospital against clinical & operational capacity constraints.
        """
        rejections = []
        c = hospital.get("capabilities") or {}
        l = hospital.get("live_status") or {}
        cap = hospital.get("capacity") or {}
        is_l1_trauma = (c.get("trauma_level") == 1 or c.get("traumaLevel") == 1)
        
        # 1. Operational emergency intake status
        op_status = (hospital.get("operational_status") or l.get("intake_status") or "OPERATIONAL").upper()
        if l.get("accepting_emergency") is False or op_status in ("DIVERTED", "CLOSED", "OFFLINE"):
            rejections.append("Hospital status is DIVERTED (not accepting emergency admissions)")
            
        # 2. ICU capacity
        if medical_reqs.get("icu"):
            has_icu_facility = (c.get("icu") is True or hospital.get("icu_beds_total", 0) > 0 or l.get("icu_capacity", 0) > 0 or cap.get("icu_beds", 0) > 0 or is_l1_trauma)
            if not has_icu_facility:
                rejections.append("No ICU facility present at hospital")
            elif available_icu <= 0:
                rejections.append(f"ICU capacity exhausted (0 available, accounts for active reservations)")
                
        # 3. ER capacity
        if available_er <= 0 and (l.get("emergency_capacity", 0) > 0 or cap.get("er_beds", 0) > 0):
            rejections.append("Emergency trauma bays fully occupied")
            
        # 4. Neurosurgery
        has_neuro = c.get("neurosurgery") or c.get("neuro_surgery") or l.get("neurosurgeon_available") or is_l1_trauma
        if medical_reqs.get("neurosurgery") and not has_neuro:
            rejections.append("Neurosurgical trauma specialist team unavailable")
            
        # 5. Orthopedics
        has_ortho = c.get("orthopedics") or c.get("orthopedic_surgery") or l.get("orthopedic_surgeon_available") or is_l1_trauma
        if medical_reqs.get("orthopedics") and not has_ortho:
            rejections.append("Orthopedic trauma surgery unit unavailable")
            
        # 6. Burn Unit
        if medical_reqs.get("burnUnit") and not c.get("burn_unit"):
            rejections.append("Specialized burn treatment unit unavailable")
            
        return (len(rejections) == 0), rejections
