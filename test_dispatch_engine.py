#!/usr/bin/env python3
"""
Automated Test Suite for Rakshak 112 Dynamic Constraint-Aware Emergency Dispatch Engine.
Tests all 20 edge cases and hard constraints specified in requirements.
"""

import sys
import os
import time
import unittest

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(CURRENT_DIR, "frontend")
if FRONTEND_DIR not in sys.path:
    sys.path.insert(0, FRONTEND_DIR)

from services.route_service import RouteService, haversine_distance
from services.resource_manager import ResourceManager
from services.ambulance_matcher import AmbulanceMatcher
from services.hospital_matcher import HospitalMatcher, build_medical_requirements
from services.dispatch_engine import DispatchEngine

class TestDispatchEngineEdgeCases(unittest.TestCase):
    def setUp(self):
        self.rm = ResourceManager(reservation_timeout_seconds=60)
        self.rs = RouteService()
        self.am = AmbulanceMatcher(rm=self.rm, rs=self.rs)
        self.hm = HospitalMatcher(rm=self.rm, rs=self.rs)
        self.engine = DispatchEngine(rm=self.rm, am=self.am, hm=self.hm, rs=self.rs)
        
        # Standard test incident (Supela Chowk, Bhilai)
        self.incident_loc = { "latitude": 21.2065, "longitude": 81.3320 }
        self.base_incident = {
            "id": "INC-TEST-001",
            "emergencyType": "Road Traffic Accident (Polytrauma)",
            "priority": { "code": "L1", "label": "CRITICAL", "score": 98 },
            "location": self.incident_loc,
            "lat": 21.2065,
            "lng": 81.3320,
            "status": "RPT",
            "triage": { "injuredCount": 2, "consciousness": "1 Unresponsive", "severeBleeding": True }
        }

    # Case 1: Nearest ambulance is not fastest (traffic-aware)
    def test_nearest_ambulance_is_not_fastest(self):
        amb_a = {
            "id": "AMB-A",
            "unit_id": "AMB-A",
            "status": "AVAILABLE",
            "vehicle_type": "ALS Ambulance",
            "equipment": { "ventilator": True, "defibrillator_aed": True },
            "live_telemetry": {
                "current_latitude": 21.2200, "current_longitude": 81.3320,
                "traffic_condition": "gridlock", "last_ping_timestamp": time.time()
            }
        }
        amb_b = {
            "id": "AMB-B",
            "unit_id": "AMB-B",
            "status": "AVAILABLE",
            "vehicle_type": "ALS Ambulance",
            "equipment": { "ventilator": True, "defibrillator_aed": True },
            "live_telemetry": {
                "current_latitude": 21.2400, "current_longitude": 81.3320,
                "traffic_condition": "clear", "last_ping_timestamp": time.time()
            }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.am.choose_best_ambulance(self.base_incident, [amb_a, amb_b], med_reqs)
        self.assertEqual(match["unit_id"], "AMB-B", "Ambulance B should be selected because it has a lower travel ETA despite being farther in distance.")

    # Case 2: Ambulance has stale GPS
    def test_ambulance_has_stale_gps(self):
        stale_amb = {
            "id": "AMB-STALE",
            "unit_id": "AMB-STALE",
            "status": "AVAILABLE",
            "equipment": { "ventilator": True },
            "live_telemetry": {
                "current_latitude": 21.2070, "current_longitude": 81.3325,
                "last_ping_timestamp": time.time() - 3600  # 1 hour old
            }
        }
        fresh_amb = {
            "id": "AMB-FRESH",
            "unit_id": "AMB-FRESH",
            "status": "AVAILABLE",
            "equipment": { "ventilator": True },
            "live_telemetry": {
                "current_latitude": 21.2150, "current_longitude": 81.3350,
                "last_ping_timestamp": time.time()
            }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.am.choose_best_ambulance(self.base_incident, [stale_amb, fresh_amb], med_reqs)
        self.assertEqual(match["unit_id"], "AMB-FRESH")
        self.assertTrue(any("Stale GPS" in r["reason"] for r in match["rejected"]))

    # Case 3: Ambulance already busy
    def test_ambulance_already_busy(self):
        busy_amb = {
            "id": "AMB-BUSY",
            "unit_id": "AMB-BUSY",
            "status": "EN_ROUTE_TO_INCIDENT",
            "equipment": { "ventilator": True },
            "live_telemetry": { "current_latitude": 21.2070, "current_longitude": 81.3325, "last_ping_timestamp": time.time() }
        }
        avail_amb = {
            "id": "AMB-AVAIL",
            "unit_id": "AMB-AVAIL",
            "status": "AVAILABLE",
            "equipment": { "ventilator": True },
            "live_telemetry": { "current_latitude": 21.2100, "current_longitude": 81.3350, "last_ping_timestamp": time.time() }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.am.choose_best_ambulance(self.base_incident, [busy_amb, avail_amb], med_reqs)
        self.assertEqual(match["unit_id"], "AMB-AVAIL")

    # Case 4: Unsuitable ambulance (medical capability mismatch)
    def test_unsuitable_ambulance(self):
        inc = dict(self.base_incident)
        inc["emergencyType"] = "Cardiac Arrest & Severe Respiratory Distress"
        med_reqs = build_medical_requirements(inc)
        self.assertTrue(med_reqs["ventilator"])

        bls_no_vent = {
            "id": "AMB-BLS",
            "unit_id": "AMB-BLS",
            "status": "AVAILABLE",
            "type": "BLS Ambulance",
            "equipment": { "ventilator": False },
            "live_telemetry": { "current_latitude": 21.2070, "current_longitude": 81.3325, "last_ping_timestamp": time.time() }
        }
        als_with_vent = {
            "id": "AMB-ALS",
            "unit_id": "AMB-ALS",
            "status": "AVAILABLE",
            "type": "ALS Ambulance",
            "equipment": { "ventilator": True },
            "live_telemetry": { "current_latitude": 21.2150, "current_longitude": 81.3350, "last_ping_timestamp": time.time() }
        }
        match = self.am.choose_best_ambulance(inc, [bls_no_vent, als_with_vent], med_reqs)
        self.assertEqual(match["unit_id"], "AMB-ALS")

    # Case 5: Two incidents compete for one ambulance
    def test_two_incidents_compete_for_one_ambulance(self):
        amb = {
            "id": "AMB-SOLO",
            "unit_id": "AMB-SOLO",
            "status": "AVAILABLE",
            "live_telemetry": { "current_latitude": 21.2070, "current_longitude": 81.3325, "last_ping_timestamp": time.time() }
        }
        ok1, msg1 = self.rm.reserve_ambulance_atomic("AMB-SOLO", "INC-001")
        self.assertTrue(ok1)
        
        ok2, msg2 = self.rm.reserve_ambulance_atomic("AMB-SOLO", "INC-002")
        self.assertFalse(ok2, "Second concurrent incident must not be able to reserve the already-locked ambulance.")

    # Case 6: One ICU bed / two patients
    def test_one_icu_bed_two_patients(self):
        hosp_h1 = {
            "id": "HOSP-H1",
            "hospital_name": "Hospital H1",
            "latitude": 21.2100, "longitude": 81.3350,
            "capabilities": { "trauma_level": 1, "icu": True, "neurosurgery": True },
            "live_status": { "icu_capacity": 1, "icu_occupied": 0, "icu_beds_available": 1, "emergency_capacity": 10, "emergency_occupied": 2, "accepting_emergency": True }
        }
        hosp_h3 = {
            "id": "HOSP-H3",
            "hospital_name": "Hospital H3",
            "latitude": 21.2250, "longitude": 81.3450,
            "capabilities": { "trauma_level": 1, "icu": True, "neurosurgery": True },
            "live_status": { "icu_capacity": 5, "icu_occupied": 2, "icu_beds_available": 3, "emergency_capacity": 10, "emergency_occupied": 2, "accepting_emergency": True }
        }
        
        med_reqs = build_medical_requirements(self.base_incident)
        match_a = self.hm.choose_best_hospital(self.base_incident, [hosp_h1, hosp_h3], 5.0, med_reqs)
        self.assertEqual(match_a["id"], "HOSP-H1")
        
        ok, _ = self.rm.reserve_hospital_resources_atomic(hosp_h1, "INC-PATIENT-A", need_icu=True, need_er=True)
        self.assertTrue(ok)
        
        cap_h1 = self.rm.get_hospital_capacity(hosp_h1)
        self.assertEqual(cap_h1["available_icu"], 0)
        
        patient_b = dict(self.base_incident, id="INC-PATIENT-B")
        match_b = self.hm.choose_best_hospital(patient_b, [hosp_h1, hosp_h3], 5.0, med_reqs)
        self.assertEqual(match_b["id"], "HOSP-H3", "Hospital H1 must be excluded for Patient B because its sole ICU bed is already reserved.")

    # Case 7: Hospital has no ICU
    def test_hospital_has_no_icu(self):
        hosp_no_icu = {
            "id": "HOSP-CLINIC",
            "hospital_name": "Day Clinic",
            "latitude": 21.2080, "longitude": 81.3330,
            "capabilities": { "icu": False, "neurosurgery": True },
            "live_status": { "icu_capacity": 0, "icu_beds_available": 0, "emergency_capacity": 5, "accepting_emergency": True }
        }
        hosp_with_icu = {
            "id": "HOSP-MAIN",
            "hospital_name": "Main Hospital",
            "latitude": 21.2300, "longitude": 81.3500,
            "capabilities": { "trauma_level": 1, "icu": True, "neurosurgery": True },
            "live_status": { "icu_capacity": 8, "icu_beds_available": 4, "emergency_capacity": 15, "accepting_emergency": True }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.hm.choose_best_hospital(self.base_incident, [hosp_no_icu, hosp_with_icu], 5.0, med_reqs)
        self.assertEqual(match["id"], "HOSP-MAIN")

    # Case 8: Hospital has ICU but no required specialty (e.g. Neurosurgery)
    def test_hospital_has_icu_but_no_specialty(self):
        hosp_general = {
            "id": "HOSP-GEN",
            "hospital_name": "General Hospital",
            "latitude": 21.2100, "longitude": 81.3350,
            "capabilities": { "icu": True, "neurosurgery": False },
            "live_status": { "icu_capacity": 5, "icu_beds_available": 3, "neurosurgeon_available": False, "accepting_emergency": True }
        }
        hosp_neuro = {
            "id": "HOSP-NEURO",
            "hospital_name": "Neuroscience Centre",
            "latitude": 21.2350, "longitude": 81.3600,
            "capabilities": { "icu": True, "neurosurgery": True },
            "live_status": { "icu_capacity": 6, "icu_beds_available": 2, "neurosurgeon_available": True, "accepting_emergency": True }
        }
        med_reqs = { "icu": True, "neurosurgery": True }
        match = self.hm.choose_best_hospital(self.base_incident, [hosp_general, hosp_neuro], 5.0, med_reqs)
        self.assertEqual(match["id"], "HOSP-NEURO")

    # Case 9: Hospital becomes full after assignment -> re-evaluation
    def test_hospital_becomes_full_after_assignment(self):
        h1 = {
            "id": "H1", "hospital_name": "Hospital H1", "latitude": 21.2100, "longitude": 81.3350,
            "capabilities": { "icu": True, "trauma_level": 1, "neurosurgery": True },
            "live_status": { "icu_capacity": 1, "icu_occupied": 0, "accepting_emergency": True }
        }
        h2 = {
            "id": "H2", "hospital_name": "Hospital H2", "latitude": 21.2300, "longitude": 81.3500,
            "capabilities": { "icu": True, "trauma_level": 1, "neurosurgery": True },
            "live_status": { "icu_capacity": 5, "icu_occupied": 1, "accepting_emergency": True }
        }
        self.engine.set_datasets([h1, h2], [], [self.base_incident])
        
        # Initial assignment to H1
        self.rm.reserve_hospital_resources_atomic(h1, self.base_incident["id"], need_icu=True)
        self.base_incident["hospitalId"] = "H1"
        self.base_incident["destinationHospital"] = "Hospital H1"
        self.base_incident["ttac_minutes"] = 10.0
        
        # External event: H1 occupied jumps to 1 (making available = 1 - 1 - 1 = -1 <= 0)
        h1["live_status"]["icu_occupied"] = 1
        
        reeval = self.engine.reevaluate_incident(self.base_incident["id"], trigger_reason="CAPACITY_CHANGED")
        self.assertTrue(reeval["reassigned"])
        self.assertEqual(self.base_incident["hospitalId"], "H2")

    # Case 10: Hospital rejects pre-alert -> auto-release and reroute
    def test_hospital_rejects_prealert(self):
        amb = {
            "id": "AMB-108", "unit_id": "AMB-108", "status": "AVAILABLE",
            "vehicle_type": "ALS Ambulance", "equipment": { "ventilator": True },
            "live_telemetry": { "current_latitude": 21.2065, "current_longitude": 81.3320, "last_ping_timestamp": time.time() }
        }
        h1 = {
            "id": "H1", "hospital_name": "Hospital H1", "latitude": 21.2100, "longitude": 81.3350,
            "capabilities": { "icu": True, "trauma_level": 1, "neurosurgery": True },
            "live_status": { "icu_capacity": 2, "icu_occupied": 0, "accepting_emergency": True }
        }
        h2 = {
            "id": "H2", "hospital_name": "Hospital H2", "latitude": 21.2400, "longitude": 81.3600,
            "capabilities": { "icu": True, "trauma_level": 1, "neurosurgery": True },
            "live_status": { "icu_capacity": 5, "icu_occupied": 1, "accepting_emergency": True }
        }
        self.engine.set_datasets([h1, h2], [amb], [self.base_incident])
        res_dispatch = self.engine.dispatch_incident(self.base_incident)
        self.assertTrue(res_dispatch["success"])
        self.assertEqual(self.base_incident["hospitalId"], "H1")
        
        # H1 rejects intake
        h1["live_status"]["accepting_emergency"] = False
        res = self.engine.handle_hospital_ack(self.base_incident["id"], "H1", accepted=False, rejection_reason="Surge capacity exceeded")
        
        self.assertTrue(res["reassigned"])
        self.assertEqual(self.base_incident["hospitalId"], "H2")

    # Case 11: Hospital acknowledgement timeout
    def test_hospital_acknowledgement_timeout(self):
        h1 = { "id": "H1", "live_status": { "icu_capacity": 2, "icu_occupied": 0 } }
        self.rm.reserve_hospital_resources_atomic(h1, "INC-TIMEOUT", need_icu=True)
        self.rm.release_hospital_reservation_only("INC-TIMEOUT")
        cap = self.rm.get_hospital_capacity(h1)
        self.assertEqual(cap["icu_reserved"], 0)

    # Case 12: Ambulance stops moving anomaly detection
    def test_ambulance_stops_moving_anomaly(self):
        resp = {
            "id": "AMB-STALL",
            "unit_id": "AMB-STALL",
            "status": "EN_ROUTE_TO_INCIDENT",
            "operational_status": "EN_ROUTE_TO_INCIDENT",
            "assigned_incident": "INC-TEST-001"
        }
        self.engine.set_datasets([], [resp], [self.base_incident])
        
        t0 = time.time() - 250
        self.engine.telemetry_history["AMB-STALL"] = { "lat": 21.2065, "lng": 81.3320, "timestamp": t0, "incident_id": "INC-TEST-001" }
        
        res = self.engine.update_responder_telemetry("AMB-STALL", 21.2065, 81.3320, speed_kmh=0.0)
        self.assertTrue(res["anomaly_detected"], "Ambulance stationary for > 180s en route must trigger movement anomaly.")

    # Case 13: Traffic makes another hospital faster
    def test_traffic_makes_another_hospital_faster(self):
        h1 = {
            "id": "H1", "hospital_name": "Hospital H1", "latitude": 21.2900, "longitude": 81.3350,
            "capabilities": { "trauma_level": 1, "icu": True, "neurosurgery": True },
            "live_status": { "icu_capacity": 5, "icu_occupied": 1, "traffic_condition": "gridlock", "accepting_emergency": True }
        }
        h2 = {
            "id": "H2", "hospital_name": "Hospital H2", "latitude": 21.3000, "longitude": 81.3350,
            "capabilities": { "trauma_level": 1, "icu": True, "neurosurgery": True },
            "live_status": { "icu_capacity": 5, "icu_occupied": 1, "traffic_condition": "clear", "accepting_emergency": True }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.hm.choose_best_hospital(self.base_incident, [h1, h2], 4.0, med_reqs)
        self.assertEqual(match["id"], "H2")

    # Case 14: Patient priority changes -> triggers medical requirements recalculation
    def test_patient_priority_changes(self):
        inc = {
            "id": "INC-014",
            "emergencyType": "Minor Collision",
            "priority": { "code": "L3", "label": "STANDARD", "score": 40 },
            "location": self.incident_loc, "lat": 21.2065, "lng": 81.3320,
            "triage": { "injuredCount": 1, "consciousness": "Alert" }
        }
        reqs_init = build_medical_requirements(inc)
        self.assertFalse(reqs_init["icu"])
        
        inc["priority"] = { "code": "L1", "label": "CRITICAL", "score": 95 }
        inc["triage"]["consciousness"] = "Unresponsive / Coma"
        reqs_updated = build_medical_requirements(inc)
        self.assertTrue(reqs_updated["icu"])
        self.assertTrue(reqs_updated["neurosurgery"])

    # Case 15: Simultaneous reservations for the last ICU bed
    def test_simultaneous_reservations_last_icu_bed(self):
        hosp = {
            "id": "H-LAST-ICU", "live_status": { "icu_capacity": 1, "icu_occupied": 0 }
        }
        ok1, _ = self.rm.reserve_hospital_resources_atomic(hosp, "INC-P1", need_icu=True)
        self.assertTrue(ok1)
        ok2, _ = self.rm.reserve_hospital_resources_atomic(hosp, "INC-P2", need_icu=True)
        self.assertFalse(ok2)

    # Case 16: Simultaneous reservations for the last ambulance
    def test_simultaneous_reservations_last_ambulance(self):
        ok1, _ = self.rm.reserve_ambulance_atomic("AMB-LAST", "INC-A")
        self.assertTrue(ok1)
        ok2, _ = self.rm.reserve_ambulance_atomic("AMB-LAST", "INC-B")
        self.assertFalse(ok2)

    # Case 17: No feasible hospital
    def test_no_feasible_hospital(self):
        hosp_diverted = {
            "id": "H-DIVERTED",
            "hospital_name": "Diverted Hospital",
            "latitude": 21.2100, "longitude": 81.3350,
            "live_status": { "accepting_emergency": False, "intake_status": "DIVERTED" }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.hm.choose_best_hospital(self.base_incident, [hosp_diverted], 5.0, med_reqs)
        self.assertIsNone(match["selected"])
        self.assertEqual(match["error"], "NO_SUITABLE_HOSPITAL")

    # Case 18: No feasible ambulance
    def test_no_feasible_ambulance(self):
        amb_busy = {
            "id": "AMB-1",
            "status": "MAINTENANCE",
            "live_telemetry": { "current_latitude": 21.2065, "current_longitude": 81.3320 }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.am.choose_best_ambulance(self.base_incident, [amb_busy], med_reqs)
        self.assertIsNone(match["selected"])
        self.assertEqual(match["error"], "NO_SUITABLE_AMBULANCE")

    # Case 19: Stale hospital capacity information
    def test_stale_hospital_capacity_information(self):
        hosp_stale = {
            "id": "H-STALE",
            "hospital_name": "Stale Intel Clinic",
            "latitude": 21.2100, "longitude": 81.3350,
            "capabilities": { "icu": True },
            "live_status": { "icu_capacity": 5, "icu_beds_available": 3, "status_confidence": "STALE_DATA_UNRELIABLE" }
        }
        med_reqs = build_medical_requirements(self.base_incident)
        match = self.hm.choose_best_hospital(self.base_incident, [hosp_stale], 5.0, med_reqs)
        self.assertIsNone(match["selected"])
        self.assertEqual(match["error"], "NO_SUITABLE_HOSPITAL")

    # Case 20: Re-optimization hysteresis prevents unnecessary oscillation
    def test_reoptimization_hysteresis_no_oscillation(self):
        h1 = {
            "id": "H1", "hospital_name": "Hospital H1", "latitude": 21.2100, "longitude": 81.3350,
            "capabilities": { "icu": True, "trauma_level": 1, "neurosurgery": True },
            "live_status": { "icu_capacity": 5, "icu_occupied": 1, "accepting_emergency": True }
        }
        h2 = {
            "id": "H2", "hospital_name": "Hospital H2", "latitude": 21.2150, "longitude": 81.3380,
            "capabilities": { "icu": True, "trauma_level": 1, "neurosurgery": True },
            "live_status": { "icu_capacity": 5, "icu_occupied": 1, "accepting_emergency": True }
        }
        self.engine.set_datasets([h1, h2], [], [self.base_incident])
        self.base_incident["hospitalId"] = "H1"
        self.base_incident["destinationHospital"] = "Hospital H1"
        self.base_incident["ttac_minutes"] = 10.0
        
        reeval = self.engine.reevaluate_incident(self.base_incident["id"], trigger_reason="MINOR_GPS_SHIFT")
        self.assertFalse(reeval["reassigned"], "Should not oscillate between hospitals for tiny ETA differences under the 2.5 min hysteresis threshold.")

if __name__ == "__main__":
    unittest.main()
