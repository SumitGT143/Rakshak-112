"""
Resource Manager for Rakshak 112 Dynamic Dispatch Engine.
Maintains atomic, thread-safe reservations for Ambulances and Hospital Critical Resources
(ICU beds, ER trauma bays, ventilators, etc.) with automatic timeout expiration.
"""

import time
import threading
from typing import Dict, Any, List, Optional, Tuple

class ResourceManager:
    def __init__(self, reservation_timeout_seconds: int = 180):
        self.lock = threading.RLock()
        self.reservation_timeout_seconds = reservation_timeout_seconds
        
        # ambulance_id -> { incident_id, status, reserved_at, expires_at }
        self.ambulance_reservations: Dict[str, Dict[str, Any]] = {}
        
        # hospital_id -> { icu_reserved, er_reserved, reservations: [ { incident_id, resource_type, reserved_at, expires_at } ] }
        self.hospital_reservations: Dict[str, Dict[str, Any]] = {}
        
        # incident_id -> { ambulance_id, hospital_id, resources_reserved: [...] }
        self.incident_bindings: Dict[str, Dict[str, Any]] = {}
        
        # Conflict logs for dispatcher visibility
        self.conflict_logs: List[Dict[str, Any]] = []

    def get_hospital_capacity(self, hospital: Dict[str, Any]) -> Dict[str, int]:
        """
        Compute real-time available capacity accounting for occupied and atomically reserved beds.
        availableICU = icu_capacity - icu_occupied - icu_reserved
        """
        with self.lock:
            h_id = hospital.get("id")
            live = hospital.get("live_status", {})
            
            # Base capacity and occupied
            icu_cap = live.get("icu_capacity", live.get("total_icu_beds", 10))
            icu_occ = live.get("icu_occupied", max(0, icu_cap - live.get("icu_beds_available", 2)))
            
            er_cap = live.get("emergency_capacity", live.get("total_emergency_beds", 20))
            er_occ = live.get("emergency_occupied", max(0, er_cap - live.get("emergency_beds_available", 5)))
            
            # Active reservations in manager
            h_res = self.hospital_reservations.get(h_id, {"icu_reserved": 0, "er_reserved": 0})
            icu_res = h_res.get("icu_reserved", 0)
            er_res = h_res.get("er_reserved", 0)
            
            available_icu = max(0, icu_cap - icu_occ - icu_res)
            available_er = max(0, er_cap - er_occ - er_res)
            
            return {
                "icu_capacity": icu_cap,
                "icu_occupied": icu_occ,
                "icu_reserved": icu_res,
                "available_icu": available_icu,
                "emergency_capacity": er_cap,
                "emergency_occupied": er_occ,
                "emergency_reserved": er_res,
                "available_er": available_er
            }

    def is_ambulance_available(self, responder: Dict[str, Any]) -> bool:
        with self.lock:
            r_id = responder.get("id") or responder.get("unit_id")
            # Base status check
            status = responder.get("status") or responder.get("operational_status", "AVAILABLE")
            if status not in ("AVAILABLE", "IDLE"):
                return False
            # Check reservation check
            if r_id in self.ambulance_reservations:
                res = self.ambulance_reservations[r_id]
                if time.time() < res.get("expires_at", 0):
                    return False
                else:
                    # Clean up expired
                    del self.ambulance_reservations[r_id]
            return True

    def reserve_ambulance_atomic(self, responder_id: str, incident_id: str) -> Tuple[bool, str]:
        with self.lock:
            now = time.time()
            if responder_id in self.ambulance_reservations:
                res = self.ambulance_reservations[responder_id]
                if now < res.get("expires_at", 0) and res.get("incident_id") != incident_id:
                    return False, f"Ambulance {responder_id} already reserved by incident {res.get('incident_id')}"
            
            self.ambulance_reservations[responder_id] = {
                "incident_id": incident_id,
                "status": "RESERVED",
                "reserved_at": now,
                "expires_at": now + self.reservation_timeout_seconds
            }
            if incident_id not in self.incident_bindings:
                self.incident_bindings[incident_id] = {}
            self.incident_bindings[incident_id]["ambulance_id"] = responder_id
            return True, "Ambulance reserved successfully"

    def reserve_hospital_resources_atomic(
        self,
        hospital: Dict[str, Any],
        incident_id: str,
        need_icu: bool = False,
        need_er: bool = True
    ) -> Tuple[bool, str]:
        with self.lock:
            now = time.time()
            h_id = hospital.get("id")
            cap = self.get_hospital_capacity(hospital)
            
            if need_icu and cap["available_icu"] <= 0:
                conflict_msg = f"ICU capacity exhausted at {hospital.get('hospital_name', h_id)} (Available: {cap['available_icu']}, Reserved: {cap['icu_reserved']})"
                self._record_conflict(incident_id, h_id, "ICU_EXHAUSTED", conflict_msg)
                return False, conflict_msg
            
            if need_er and cap["available_er"] <= 0:
                conflict_msg = f"ER trauma bay exhausted at {hospital.get('hospital_name', h_id)}"
                self._record_conflict(incident_id, h_id, "ER_EXHAUSTED", conflict_msg)
                return False, conflict_msg
            
            if h_id not in self.hospital_reservations:
                self.hospital_reservations[h_id] = {
                    "icu_reserved": 0,
                    "er_reserved": 0,
                    "reservations": []
                }
            
            # Apply reservation increments
            if need_icu:
                self.hospital_reservations[h_id]["icu_reserved"] += 1
            if need_er:
                self.hospital_reservations[h_id]["er_reserved"] += 1
            
            self.hospital_reservations[h_id]["reservations"].append({
                "incident_id": incident_id,
                "need_icu": need_icu,
                "need_er": need_er,
                "reserved_at": now,
                "expires_at": now + self.reservation_timeout_seconds
            })
            
            if incident_id not in self.incident_bindings:
                self.incident_bindings[incident_id] = {}
            self.incident_bindings[incident_id]["hospital_id"] = h_id
            self.incident_bindings[incident_id]["need_icu"] = need_icu
            self.incident_bindings[incident_id]["need_er"] = need_er
            
            return True, "Hospital resources atomically reserved"

    def release_incident_reservations(self, incident_id: str):
        """Release both ambulance and hospital reservations for an incident upon resolution/reassignment."""
        with self.lock:
            binding = self.incident_bindings.pop(incident_id, None)
            if not binding:
                return
            
            # Release ambulance
            amb_id = binding.get("ambulance_id")
            if amb_id and amb_id in self.ambulance_reservations:
                if self.ambulance_reservations[amb_id].get("incident_id") == incident_id:
                    del self.ambulance_reservations[amb_id]
            
            # Release hospital
            h_id = binding.get("hospital_id")
            if h_id and h_id in self.hospital_reservations:
                h_res = self.hospital_reservations[h_id]
                matching = [r for r in h_res["reservations"] if r.get("incident_id") == incident_id]
                for r in matching:
                    if r.get("need_icu"):
                        h_res["icu_reserved"] = max(0, h_res["icu_reserved"] - 1)
                    if r.get("need_er"):
                        h_res["er_reserved"] = max(0, h_res["er_reserved"] - 1)
                    h_res["reservations"].remove(r)

    def release_hospital_reservation_only(self, incident_id: str):
        """Release only hospital reservation (e.g. When hospital rejects or times out and we need to reroute)."""
        with self.lock:
            if incident_id not in self.incident_bindings:
                return
            binding = self.incident_bindings[incident_id]
            h_id = binding.get("hospital_id")
            if h_id and h_id in self.hospital_reservations:
                h_res = self.hospital_reservations[h_id]
                matching = [r for r in h_res["reservations"] if r.get("incident_id") == incident_id]
                for r in matching:
                    if r.get("need_icu"):
                        h_res["icu_reserved"] = max(0, h_res["icu_reserved"] - 1)
                    if r.get("need_er"):
                        h_res["er_reserved"] = max(0, h_res["er_reserved"] - 1)
                    h_res["reservations"].remove(r)
            binding["hospital_id"] = None

    def _record_conflict(self, incident_id: str, hospital_id: str, conflict_type: str, reason: str):
        self.conflict_logs.insert(0, {
            "timestamp": time.time(),
            "incident_id": incident_id,
            "hospital_id": hospital_id,
            "type": conflict_type,
            "reason": reason
        })
        if len(self.conflict_logs) > 50:
            self.conflict_logs.pop()

    def get_aggregate_resource_status(self, hospitals: List[Dict[str, Any]], responders: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Aggregate totals for Resource Status Panel in UI."""
        with self.lock:
            total_icu_cap = 0
            total_icu_occ = 0
            total_icu_res = 0
            
            total_er_cap = 0
            total_er_occ = 0
            total_er_res = 0
            
            for h in hospitals:
                cap = self.get_hospital_capacity(h)
                total_icu_cap += cap["icu_capacity"]
                total_icu_occ += cap["icu_occupied"]
                total_icu_res += cap["icu_reserved"]
                
                total_er_cap += cap["emergency_capacity"]
                total_er_occ += cap["emergency_occupied"]
                total_er_res += cap["emergency_reserved"]
            
            total_amb = len(responders)
            avail_amb = sum(1 for r in responders if self.is_ambulance_available(r))
            dispatched_amb = len(self.ambulance_reservations)
            busy_amb = total_amb - avail_amb
            
            return {
                "icu": {
                    "available": max(0, total_icu_cap - total_icu_occ - total_icu_res),
                    "occupied": total_icu_occ,
                    "reserved": total_icu_res,
                    "capacity": total_icu_cap
                },
                "er": {
                    "available": max(0, total_er_cap - total_er_occ - total_er_res),
                    "occupied": total_er_occ,
                    "reserved": total_er_res,
                    "capacity": total_er_cap
                },
                "ambulances": {
                    "available": avail_amb,
                    "dispatched": dispatched_amb,
                    "busy": busy_amb,
                    "total": total_amb
                },
                "active_conflicts": self.conflict_logs[:5]
            }

# Global singleton
resource_manager = ResourceManager()
