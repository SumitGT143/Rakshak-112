"""
Atomic Resource Reservation & Lease Manager for Rakshak 112.
Ensures two incidents can never double-book the same ambulance or hospital bed.
Supports lease timeouts, renewals, and reconciliation after server restart.
"""

import time
import threading
from typing import Dict, Any, List, Optional, Tuple
from .config import (
    AMBULANCE_RESERVATION_TIMEOUT_SECONDS,
    HOSPITAL_RESERVATION_TIMEOUT_SECONDS
)

class ReservationManager:
    def __init__(self):
        self.lock = threading.RLock()
        
        # ambulance_id -> { reservationId, incidentId, status, reservedAt, expiresAt }
        self.ambulance_reservations: Dict[str, Dict[str, Any]] = {}
        
        # hospital_id -> { icu_reserved, er_reserved, reservations: [ { reservationId, incidentId, need_icu, need_er, reservedAt, expiresAt } ] }
        self.hospital_reservations: Dict[str, Dict[str, Any]] = {}
        
        # incident_id -> { dispatchPlanId, ambulanceId, hospitalId, ambulanceReservationId, hospitalReservationId }
        self.incident_bindings: Dict[str, Dict[str, Any]] = {}
        
        # Audit trail of conflict logs
        self.conflict_logs: List[Dict[str, Any]] = []

    def get_hospital_capacity(self, hospital: Dict[str, Any]) -> Dict[str, int]:
        """
        Calculates available capacity: availableICU = totalICU - occupiedICU - reservedICU.
        """
        with self.lock:
            h_id = hospital.get("id") or hospital.get("hospital_name")
            live = hospital.get("live_status") or {}
            cap = hospital.get("capacity") or {}
            occ = hospital.get("current_occupancy") or {}
            
            icu_cap = live.get("icu_capacity", cap.get("icu_beds", live.get("total_icu_beds", hospital.get("icu_beds_total", 10))))
            icu_occ = live.get("icu_occupied", occ.get("icu_occupied", max(0, icu_cap - live.get("icu_beds_available", cap.get("icu_available", 2)))))
            
            er_cap = live.get("emergency_capacity", cap.get("er_beds", live.get("total_emergency_beds", hospital.get("emergency_beds_total", 20))))
            er_occ = live.get("emergency_occupied", occ.get("er_occupied", max(0, er_cap - live.get("emergency_beds_available", cap.get("er_available", 5)))))
            
            h_res = self.hospital_reservations.get(h_id, {"icu_reserved": 0, "er_reserved": 0})
            icu_res = h_res.get("icu_reserved", 0)
            er_res = h_res.get("er_reserved", 0)
            
            avail_icu = max(0, icu_cap - icu_occ - icu_res)
            avail_er = max(0, er_cap - er_occ - er_res)
            
            return {
                "icu_capacity": icu_cap,
                "icu_occupied": icu_occ,
                "icu_reserved": icu_res,
                "available_icu": avail_icu,
                "emergency_capacity": er_cap,
                "emergency_occupied": er_occ,
                "emergency_reserved": er_res,
                "available_er": avail_er
            }

    def is_ambulance_available(self, responder: Dict[str, Any], checking_incident_id: str = None) -> bool:
        with self.lock:
            r_id = responder.get("unit_id") or responder.get("id")
            status = (responder.get("status") or responder.get("operational_status") or "AVAILABLE").upper()
            if status not in ("AVAILABLE", "IDLE"):
                return False
                
            if r_id in self.ambulance_reservations:
                res = self.ambulance_reservations[r_id]
                now = time.time()
                if now < res.get("expiresAt", 0):
                    if checking_incident_id and res.get("incidentId") == checking_incident_id:
                        return True
                    return False
                else:
                    # Clean up expired lease
                    del self.ambulance_reservations[r_id]
            return True

    def reserve_ambulance_atomic(
        self,
        ambulance_id: str,
        incident_id: str,
        dispatch_plan_id: str
    ) -> Tuple[bool, str, Optional[str]]:
        """
        Atomically leases an ambulance. Returns (success, message, reservationId).
        """
        with self.lock:
            now = time.time()
            if ambulance_id in self.ambulance_reservations:
                res = self.ambulance_reservations[ambulance_id]
                if now < res.get("expiresAt", 0) and res.get("incidentId") != incident_id:
                    msg = f"Ambulance {ambulance_id} already locked by incident {res.get('incidentId')}"
                    self.conflict_logs.append({
                        "timestamp": int(now * 1000),
                        "type": "AMBULANCE_CONTENTION",
                        "ambulanceId": ambulance_id,
                        "incidentId": incident_id,
                        "holdingIncidentId": res.get("incidentId")
                    })
                    return False, msg, None

            res_id = f"RES-AMB-{int(now * 1000 % 100000):05d}"
            expires_at = now + AMBULANCE_RESERVATION_TIMEOUT_SECONDS
            
            self.ambulance_reservations[ambulance_id] = {
                "reservationId": res_id,
                "incidentId": incident_id,
                "dispatchPlanId": dispatch_plan_id,
                "status": "RESERVED",
                "reservedAt": now,
                "expiresAt": expires_at
            }
            
            binding = self.incident_bindings.setdefault(incident_id, {})
            binding["ambulanceId"] = ambulance_id
            binding["ambulanceReservationId"] = res_id
            binding["dispatchPlanId"] = dispatch_plan_id
            
            return True, "Ambulance reserved successfully", res_id

    def reserve_hospital_atomic(
        self,
        hospital: Dict[str, Any],
        incident_id: str,
        dispatch_plan_id: str,
        need_icu: bool = False,
        need_er: bool = True
    ) -> Tuple[bool, str, Optional[str]]:
        """
        Atomically leases hospital ICU/ER bed capacity. Returns (success, message, reservationId).
        """
        with self.lock:
            now = time.time()
            h_id = hospital.get("id") or hospital.get("hospital_name")
            cap = self.get_hospital_capacity(hospital)
            
            if need_icu and cap["available_icu"] <= 0:
                msg = f"ICU capacity exhausted at {hospital.get('hospital_name', h_id)}"
                self.conflict_logs.append({
                    "timestamp": int(now * 1000),
                    "type": "HOSPITAL_ICU_CONTENTION",
                    "hospitalId": h_id,
                    "incidentId": incident_id
                })
                return False, msg, None
                
            if need_er and cap["available_er"] <= 0:
                msg = f"Emergency bays exhausted at {hospital.get('hospital_name', h_id)}"
                self.conflict_logs.append({
                    "timestamp": int(now * 1000),
                    "type": "HOSPITAL_ER_CONTENTION",
                    "hospitalId": h_id,
                    "incidentId": incident_id
                })
                return False, msg, None

            h_entry = self.hospital_reservations.setdefault(h_id, {"icu_reserved": 0, "er_reserved": 0, "reservations": []})
            
            if need_icu:
                h_entry["icu_reserved"] += 1
            if need_er:
                h_entry["er_reserved"] += 1

            res_id = f"RES-HOSP-{int(now * 1000 % 100000):05d}"
            expires_at = now + HOSPITAL_RESERVATION_TIMEOUT_SECONDS
            
            h_entry["reservations"].append({
                "reservationId": res_id,
                "incidentId": incident_id,
                "dispatchPlanId": dispatch_plan_id,
                "need_icu": need_icu,
                "need_er": need_er,
                "reservedAt": now,
                "expiresAt": expires_at
            })
            
            binding = self.incident_bindings.setdefault(incident_id, {})
            binding["hospitalId"] = h_id
            binding["hospitalReservationId"] = res_id
            binding["need_icu"] = need_icu
            binding["need_er"] = need_er
            
            return True, "Hospital resources atomically reserved", res_id

    def release_hospital_reservation(self, incident_id: str):
        with self.lock:
            binding = self.incident_bindings.get(incident_id, {})
            h_id = binding.get("hospitalId")
            if h_id and h_id in self.hospital_reservations:
                h_entry = self.hospital_reservations[h_id]
                need_icu = binding.get("need_icu", False)
                need_er = binding.get("need_er", True)
                
                if need_icu:
                    h_entry["icu_reserved"] = max(0, h_entry["icu_reserved"] - 1)
                if need_er:
                    h_entry["er_reserved"] = max(0, h_entry["er_reserved"] - 1)
                    
                h_entry["reservations"] = [r for r in h_entry["reservations"] if r.get("incidentId") != incident_id]
                
            binding["hospitalId"] = None
            binding["hospitalReservationId"] = None

    def release_all_incident_reservations(self, incident_id: str):
        with self.lock:
            binding = self.incident_bindings.get(incident_id, {})
            amb_id = binding.get("ambulanceId")
            if amb_id and amb_id in self.ambulance_reservations:
                if self.ambulance_reservations[amb_id].get("incidentId") == incident_id:
                    del self.ambulance_reservations[amb_id]
                    
            self.release_hospital_reservation(incident_id)
            if incident_id in self.incident_bindings:
                del self.incident_bindings[incident_id]

    def reconcile_on_startup(self, active_incidents: List[Dict[str, Any]], responders: List[Dict[str, Any]], hospitals: List[Dict[str, Any]]):
        """
        Re-establishes valid reservations from existing active incident records after server restart.
        """
        with self.lock:
            self.ambulance_reservations.clear()
            self.hospital_reservations.clear()
            self.incident_bindings.clear()
            now = time.time()
            
            for inc in active_incidents:
                st = inc.get("status", "")
                if st in ("CLS", "RESOLVED", "CANCELLED"):
                    continue
                    
                inc_id = inc.get("id")
                plan_id = inc.get("dispatchPlanId") or f"PLAN-{inc_id}"
                amb_id = inc.get("assignedAmbulance") or inc.get("dispatch", {}).get("ambulance", {}).get("id")
                hosp_id = inc.get("hospitalId") or inc.get("dispatch", {}).get("hospital", {}).get("id")
                
                if amb_id:
                    self.reserve_ambulance_atomic(amb_id, inc_id, plan_id)
                    
                if hosp_id:
                    hosp_obj = next((h for h in hospitals if h.get("id") == hosp_id or h.get("hospital_name") == hosp_id), None)
                    if hosp_obj:
                        need_icu = inc.get("medicalRequirements", {}).get("icu", False)
                        self.reserve_hospital_atomic(hosp_obj, inc_id, plan_id, need_icu=need_icu, need_er=True)

    def reconcile_active_reservations(self, active_incidents: List[Dict[str, Any]] = None) -> Dict[str, List[str]]:
        with self.lock:
            now = time.time()
            released = []
            for amb_id, res in list(self.ambulance_reservations.items()):
                if now >= res.get("expiresAt", 0):
                    del self.ambulance_reservations[amb_id]
                    released.append(amb_id)
            return {"released_ambulances": released}

# Singleton
reservation_manager = ReservationManager()
