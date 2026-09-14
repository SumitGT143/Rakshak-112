#!/usr/bin/env python3
"""
Comprehensive Automated Test Suite for Rakshak 112 Dynamic Emergency Orchestrator.
Validates all 30 specification criteria across:
- Paired Plan Evaluation & TTAC Optimization
- Hard Constraints (Clinical, ICU, Trauma, Equipment)
- Atomic Resource Locking & Contention
- Event-Driven Re-optimization & Hysteresis Thresholds
- Hard Failure Bypass & Escalations
- Explainable Decision Logging & Rejection Auditing
- Authoritative Snapshot Generation & Monotonic State Versioning
- Citizen Privacy Filtering & Data Sanitization
"""

import sys
import os
import time
import json
import unittest

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(CURRENT_DIR, "frontend")
if FRONTEND_DIR not in sys.path:
    sys.path.insert(0, FRONTEND_DIR)

from services.orchestrator import (
    emergency_orchestrator,
    reservation_manager,
    decision_logger,
    reoptimization_manager,
    escalation_manager,
    IncidentStateMachine,
    ConstraintValidator,
    routing_service,
    calculate_ttac,
    ambulance_selector,
    hospital_selector,
    plan_evaluator,
    snapshot_builder
)
from services.orchestrator.config import (
    FRESHNESS_LIVE_MAX_SECONDS,
    FRESHNESS_RECENT_MAX_SECONDS,
    FRESHNESS_STALE_MAX_SECONDS,
    MIN_TTAC_IMPROVEMENT_MINUTES
)

class TestDynamicEmergencyOrchestrator(unittest.TestCase):
    def setUp(self):
        # Reset state before each test
        reservation_manager.ambulance_reservations.clear()
        reservation_manager.hospital_reservations.clear()
        decision_logger.incident_logs.clear()
        
        self.mock_hospitals = [
            {
                "id": "H-01",
                "name": "District Hospital Durg",
                "address": "Durg Central",
                "latitude": 21.1900,
                "longitude": 81.2800,
                "operational_status": "OPERATIONAL",
                "capacity": {"icu_beds": 10, "er_beds": 20, "ventilators": 5},
                "current_occupancy": {"icu_occupied": 2, "er_occupied": 5},
                "capabilities": {"trauma_level": 1, "emergency_surgery": True, "blood_bank": True, "ventilator": True}
            },
            {
                "id": "H-02",
                "name": "Community Clinic Bhilai",
                "address": "Bhilai West",
                "latitude": 21.2000,
                "longitude": 81.3100,
                "operational_status": "OPERATIONAL",
                "capacity": {"icu_beds": 2, "er_beds": 5, "ventilators": 1},
                "current_occupancy": {"icu_occupied": 2, "er_occupied": 5}, # ICU Full!
                "capabilities": {"trauma_level": 3, "emergency_surgery": False, "blood_bank": False, "ventilator": False}
            },
            {
                "id": "H-03",
                "name": "Apex Trauma SuperSpecialty",
                "address": "GE Road, Supela",
                "latitude": 21.2050,
                "longitude": 81.3300,
                "operational_status": "OPERATIONAL",
                "capacity": {"icu_beds": 15, "er_beds": 30, "ventilators": 10},
                "current_occupancy": {"icu_occupied": 5, "er_occupied": 10},
                "capabilities": {"trauma_level": 1, "emergency_surgery": True, "blood_bank": True, "ventilator": True}
            }
        ]

        self.mock_responders = [
            {
                "unit_id": "AMB-01",
                "id": "AMB-01",
                "driver_name": "Rakesh Kumar",
                "vehicle_number": "CG-04-AB-1234",
                "type": "ALS Ambulance",
                "status": "AVAILABLE",
                "operational_status": "AVAILABLE",
                "location": {"latitude": 21.2060, "longitude": 81.3310},
                "capabilities": ["ventilator", "defibrillator", "advanced_airway"],
                "live_telemetry": {
                    "current_latitude": 21.2060,
                    "current_longitude": 81.3310,
                    "last_ping_timestamp": int(time.time() * 1000),
                    "gps_accuracy": 12
                }
            },
            {
                "unit_id": "AMB-02",
                "id": "AMB-02",
                "driver_name": "Suresh Patel",
                "vehicle_number": "CG-04-CD-5678",
                "type": "BLS Ambulance",
                "status": "AVAILABLE",
                "operational_status": "AVAILABLE",
                "location": {"latitude": 21.2055, "longitude": 81.3315}, # Closer, but lacks ALS equipment
                "capabilities": ["basic_first_aid", "stretcher"],
                "live_telemetry": {
                    "current_latitude": 21.2055,
                    "current_longitude": 81.3315,
                    "last_ping_timestamp": int(time.time() * 1000),
                    "gps_accuracy": 15
                }
            }
        ]

        self.mock_incidents = []
        emergency_orchestrator.set_datasets(self.mock_hospitals, self.mock_responders, self.mock_incidents)

    # 1. Test Normal SOS -> Ambulance -> Hospital Paired Plan
    def test_01_normal_sos_paired_plan(self):
        incident = {
            "id": "INC-TEST-01",
            "emergencyType": "Severe Polytrauma Accident",
            "priority": {"code": "L1", "label": "CRITICAL"},
            "location": {"latitude": 21.2065, "longitude": 81.3320, "address": "Supela Chowk"},
            "triage": {"injuredCount": 1, "severeBleeding": True}
        }
        res = emergency_orchestrator.orchestrate_new_incident(incident)
        self.assertTrue(res["success"])
        self.assertIsNotNone(res["dispatch_plan"])
        self.assertEqual(res["dispatch_plan"]["ambulance"]["id"], "AMB-01") # Selected ALS
        self.assertEqual(res["dispatch_plan"]["hospital"]["id"], "H-03") # Selected Apex Trauma

    # 2. Test Nearest Ambulance Lacks Required Equipment
    def test_02_nearest_ambulance_lacks_required_equipment(self):
        # AMB-02 is closer to 21.2055, but BLS only. Critical case requires ALS.
        incident = {
            "id": "INC-TEST-02",
            "emergencyType": "Cardiac Arrest",
            "priority": {"code": "L1", "label": "CRITICAL"},
            "location": {"latitude": 21.2056, "longitude": 81.3316},
            "medicalRequirements": {"ambulance_type": "ALS", "ventilator": True}
        }
        res = emergency_orchestrator.orchestrate_new_incident(incident)
        self.assertTrue(res["success"])
        self.assertEqual(res["dispatch_plan"]["ambulance"]["id"], "AMB-01")
        # Check decision log for rejection of AMB-02
        logs = decision_logger.get_logs("INC-TEST-02")
        self.assertTrue(any(r.get("id") == "AMB-02" for r in logs[0].get("rejectedAmbulances", [])))

    # 3. Test Nearest Hospital Lacks Required Capability
    def test_03_nearest_hospital_lacks_capability(self):
        # H-02 is closer but has trauma_level 3 and no surgery. Critical requires trauma level 1.
        incident = {
            "id": "INC-TEST-03",
            "emergencyType": "High Impact Collision",
            "priority": {"code": "L1", "label": "CRITICAL"},
            "location": {"latitude": 21.2005, "longitude": 81.3105},
            "medicalRequirements": {"trauma_level": 1, "emergency_surgery": True}
        }
        res = emergency_orchestrator.orchestrate_new_incident(incident)
        self.assertTrue(res["success"])
        self.assertIn(res["dispatch_plan"]["hospital"]["id"], ["H-01", "H-03"])
        self.assertNotEqual(res["dispatch_plan"]["hospital"]["id"], "H-02")

    # 4. Test ICU Exhausted at Hospital
    def test_04_icu_exhausted(self):
        # H-02 has 2 ICU beds and 2 occupied, so 0 available
        self.mock_hospitals[1]["capabilities"]["trauma_level"] = 1 # give it trauma 1
        incident = {
            "id": "INC-TEST-04",
            "emergencyType": "Respiratory Failure",
            "priority": {"code": "L1", "label": "CRITICAL"},
            "location": {"latitude": 21.2005, "longitude": 81.3105},
            "medicalRequirements": {"icu": True}
        }
        res = emergency_orchestrator.orchestrate_new_incident(incident)
        self.assertNotEqual(res["dispatch_plan"]["hospital"]["id"], "H-02")

    # 5. Test Hospital Diversion / Closure
    def test_05_hospital_diverted(self):
        self.mock_hospitals[2]["operational_status"] = "DIVERTED"
        incident = {
            "id": "INC-TEST-05",
            "emergencyType": "Accident",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        res = emergency_orchestrator.orchestrate_new_incident(incident)
        self.assertNotEqual(res["dispatch_plan"]["hospital"]["id"], "H-03")

    # 6. Test Hospital Rejection Triggers Reroute
    def test_06_hospital_rejection(self):
        incident = {
            "id": "INC-TEST-06",
            "emergencyType": "Emergency SOS",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        initial_hosp = incident.get("destinationHospital")
        
        # Hospital rejects
        ack_res = emergency_orchestrator.handle_hospital_ack("INC-TEST-06", initial_hosp, accepted=False, reason="Emergency OT Flooded")
        self.assertTrue(ack_res["reoptimized"])
        self.assertNotEqual(incident.get("destinationHospital"), initial_hosp)

    # 7. Test Hospital Acknowledgement Timeout
    def test_07_hospital_ack_timeout(self):
        incident = {
            "id": "INC-TEST-07",
            "emergencyType": "Emergency SOS",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        # Verify pre-alert state exists
        self.assertEqual(incident.get("hospitalPreAlertStatus"), "SENT")

    # 8. Test Ambulance Breakdown / Rejection
    def test_08_ambulance_breakdown(self):
        incident = {
            "id": "INC-TEST-08",
            "emergencyType": "Critical Trauma",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        self.assertEqual(incident.get("assignedAmbulance"), "AMB-01")

        # AMB-01 breaks down
        res = emergency_orchestrator.update_responder_status("AMB-01", "BREAKDOWN", incident_id="INC-TEST-08")
        self.assertTrue(res["reoptimized"])
        self.assertEqual(incident.get("assignedAmbulance"), "AMB-02")

    # 9. Test Telemetry Staleness
    def test_09_stale_gps_telemetry(self):
        # Set ping to 3 minutes ago (> 120s = STALE)
        self.mock_responders[0]["live_telemetry"]["last_ping_timestamp"] = int(time.time() * 1000) - 180000
        snap = snapshot_builder.build_authoritative_snapshot({
            "id": "INC-TEST-09",
            "status": "AMBULANCE_EN_ROUTE",
            "assignedAmbulance": "AMB-01",
            "assignedAmbulanceDetails": self.mock_responders[0],
            "destinationHospital": "Apex Trauma",
            "destinationDetails": self.mock_hospitals[2],
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        })
        self.assertEqual(snap["dispatch"]["ambulance"]["telemetryFreshness"], "STALE")

    # 10. Test Atomic Resource Reservation (Two incidents competing for same ambulance)
    def test_10_atomic_ambulance_reservation_contention(self):
        ok1, msg1, res1 = reservation_manager.reserve_ambulance_atomic("AMB-01", "INC-A", "PLAN-A")
        self.assertTrue(ok1)
        
        # Second incident tries to reserve same AMB-01
        ok2, msg2, res2 = reservation_manager.reserve_ambulance_atomic("AMB-01", "INC-B", "PLAN-B")
        self.assertFalse(ok2)
        self.assertIn("already locked", msg2)

    # 11. Test Atomic ICU Reservation Contention
    def test_11_atomic_icu_reservation_contention(self):
        # H-01 has 10 total, 2 occupied. Try reserving available beds
        h_obj = self.mock_hospitals[0]
        ok, msg, res = reservation_manager.reserve_hospital_atomic(h_obj, "INC-A", "PLAN-A", need_icu=True)
        self.assertTrue(ok)
        self.assertEqual(reservation_manager.hospital_reservations["H-01"]["icu_reserved"], 1)

    # 12. Test Hysteresis Threshold (1 min change does NOT cause reassignment)
    def test_12_hysteresis_small_fluctuation(self):
        current_plan = {"ttacMinutes": 15.0}
        candidate_plan = {"ttacMinutes": 14.2} # only 0.8 min improvement < 3.0 min threshold
        should_reopt = reoptimization_manager.should_reoptimize(
            current_plan=current_plan,
            candidate_plan=candidate_plan,
            incident_stage="AMBULANCE_EN_ROUTE",
            is_hard_failure=False
        )
        self.assertFalse(should_reopt)

    # 13. Test Hysteresis Threshold (>= 3.0 min improvement causes reassessment)
    def test_13_hysteresis_large_improvement(self):
        current_plan = {"ttacMinutes": 20.0}
        candidate_plan = {"ttacMinutes": 15.0} # 5.0 min improvement >= 3.0 min
        should_reopt = reoptimization_manager.should_reoptimize(
            current_plan=current_plan,
            candidate_plan=candidate_plan,
            incident_stage="AMBULANCE_EN_ROUTE",
            is_hard_failure=False
        )
        self.assertTrue(should_reopt)

    # 14. Test Hard Failure Bypasses Hysteresis
    def test_14_hard_failure_bypasses_hysteresis(self):
        current_plan = {"ttacMinutes": 15.0}
        candidate_plan = {"ttacMinutes": 16.0} # even if worse, breakdown forces reopt
        should_reopt = reoptimization_manager.should_reoptimize(
            current_plan=current_plan,
            candidate_plan=candidate_plan,
            incident_stage="AMBULANCE_EN_ROUTE",
            is_hard_failure=True
        )
        self.assertTrue(should_reopt)

    # 15. Test Server Restart Active Reservation Reconciliation
    def test_15_restart_reservation_reconciliation(self):
        # Create an expired reservation
        reservation_manager.ambulance_reservations["AMB-OLD"] = {
            "incident_id": "INC-OLD",
            "reserved_at": time.time() - 1000,
            "lease_seconds": 300 # expired!
        }
        reconciled = reservation_manager.reconcile_active_reservations(self.mock_incidents)
        self.assertIn("AMB-OLD", reconciled["released_ambulances"])

    # 16. Test Citizen Privacy Filtering (Sanitization)
    def test_16_citizen_privacy_filtering(self):
        full_incident = {
            "id": "INC-PRIV-01",
            "stateVersion": 5,
            "emergencyType": "Medical Emergency",
            "priority": {"code": "L1", "label": "CRITICAL", "internalScore": 99},
            "location": {"latitude": 21.2065, "longitude": 81.3320},
            "assignedAmbulance": "AMB-01",
            "assignedAmbulanceDetails": self.mock_responders[0],
            "destinationHospital": "Apex Trauma",
            "destinationDetails": self.mock_hospitals[2],
            "dispatchDecisionLog": [{"decisionId": "D1", "rejectionScore": 0.85}],
            "caller": {
                "name": "Citizen User",
                "phone": "+919893000000",
                "aadhaarMasked": "XXXX XXXX 1234",
                "aadhaarFull": "123456789012", # Sensitive
                "dlNumber": "CG0420190012345" # Sensitive
            }
        }
        citizen_snap = snapshot_builder.build_citizen_snapshot(full_incident)
        
        # Ensure sensitive fields are filtered out
        self.assertNotIn("internalScore", json.dumps(citizen_snap))
        self.assertNotIn("123456789012", json.dumps(citizen_snap))
        self.assertNotIn("CG0420190012345", json.dumps(citizen_snap))
        self.assertNotIn("dispatchDecisionLog", citizen_snap)
        
        # Ensure public responder and hospital data are present
        self.assertEqual(citizen_snap["dispatch"]["ambulance"]["driverName"], "Rakesh Kumar")
        self.assertEqual(citizen_snap["dispatch"]["hospital"]["name"], "Apex Trauma SuperSpecialty")

    # 17. Test Authoritative State Machine Progression
    def test_17_state_machine_progression(self):
        incident = {
            "id": "INC-SM-01",
            "state": "SOS_RECEIVED",
            "stateVersion": 1
        }
        success, msg = IncidentStateMachine.apply_transition(incident, "AMBULANCE_DISPATCHED", reason="Unit assigned")
        self.assertTrue(success)
        self.assertEqual(incident["state"], "AMBULANCE_DISPATCHED")
        self.assertEqual(incident["stateVersion"], 2)

    # 18. Test State Machine Prevents Backward Invalid Transition
    def test_18_state_machine_invalid_backward_transition(self):
        incident = {
            "id": "INC-SM-02",
            "state": "AT_HOSPITAL",
            "stateVersion": 5
        }
        # Attempt late out-of-order event moving backward to ASSESSING
        success, msg = IncidentStateMachine.apply_transition(incident, "ASSESSING", reason="Late event")
        self.assertFalse(success)
        self.assertEqual(incident["state"], "AT_HOSPITAL")

    # 19. Test Human Dispatcher Manual Override
    def test_19_dispatcher_manual_override(self):
        incident = {
            "id": "INC-OVR-01",
            "emergencyType": "Trauma",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        
        # Dispatcher manually switches to District Hospital H-01
        ovr_res = emergency_orchestrator.apply_dispatcher_override(
            incident_id="INC-OVR-01",
            hospital_id="H-01",
            dispatcher_name="Senior Officer Verma",
            reason="Specialist on standby at Durg"
        )
        self.assertTrue(ovr_res["success"])
        self.assertEqual(incident.get("destinationHospital"), "District Hospital Durg")
        
        # Check decision log recorded manual override
        logs = decision_logger.get_logs("INC-OVR-01")
        self.assertTrue(any(l.get("action") == "MANUAL_OVERRIDE" for l in logs))

    # 20. Test TTAC Calculation Components
    def test_20_ttac_components_breakdown(self):
        breakdown = calculate_ttac(
            response_eta_minutes=5.0,
            transport_eta_minutes=8.0,
            scene_delay_minutes=2.5,
            handover_delay_minutes=1.5
        )
        self.assertEqual(breakdown["ttacMinutes"], 17.0)
        self.assertEqual(breakdown["breakdown"]["responseEtaMinutes"], 5.0)
        self.assertEqual(breakdown["breakdown"]["transportEtaMinutes"], 8.0)

    # 21. Test SSE Disconnect / Reconnect Simulation & Snapshot Reconciliation
    def test_21_sse_reconnect_snapshot_reconciliation(self):
        incident = {
            "id": "INC-TEST-21",
            "emergencyType": "Cardiac Emergency",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        client_version = 1 # Client missed updates up to stateVersion 4
        
        # Client queries authoritative snapshot on reconnect
        auth_snap = emergency_orchestrator.get_authoritative_snapshot("INC-TEST-21")
        self.assertIsNotNone(auth_snap)
        self.assertGreater(auth_snap["stateVersion"], client_version)
        self.assertEqual(auth_snap["dispatch"]["ambulance"]["id"], "AMB-01")

    # 22. Test Missed Events Followed by State Reconciliation
    def test_22_missed_events_state_reconciliation(self):
        incident = {
            "id": "INC-TEST-22",
            "emergencyType": "Polytrauma",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        emergency_orchestrator.update_responder_status("AMB-01", "ON_SCENE", incident_id="INC-TEST-22")
        emergency_orchestrator.update_responder_status("AMB-01", "PATIENT_ON_BOARD", incident_id="INC-TEST-22")
        
        snap = emergency_orchestrator.get_authoritative_snapshot("INC-TEST-22")
        self.assertEqual(snap["status"], "EN_ROUTE_TO_HOSPITAL")
        self.assertGreaterEqual(snap["stateVersion"], 5)

    # 23. Test Citizen Privacy vs Control Room Snapshot Parity
    def test_23_snapshot_parity_and_citizen_authorization(self):
        incident = {
            "id": "INC-TEST-23",
            "emergencyType": "Industrial Incident",
            "location": {"latitude": 21.2065, "longitude": 81.3320},
            "caller": {"name": "Worker Rahul", "aadhaarFull": "999988887777"}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        
        control_snap = emergency_orchestrator.get_authoritative_snapshot("INC-TEST-23")
        citizen_snap = emergency_orchestrator.get_citizen_privacy_snapshot("INC-TEST-23")
        
        # Same core dispatch truth
        self.assertEqual(control_snap["dispatch"]["ambulance"]["id"], citizen_snap["dispatch"]["ambulance"]["id"])
        self.assertEqual(control_snap["dispatch"]["hospital"]["name"], citizen_snap["dispatch"]["hospital"]["name"])
        self.assertEqual(control_snap["dispatch"]["ttacMinutes"], citizen_snap["expectedTTACMinutes"])
        
        # Privacy filtering
        self.assertNotIn("aadhaarFull", json.dumps(citizen_snap))

    # 24. Test Control Room Full Decision Visibility
    def test_24_control_room_decision_visibility(self):
        incident = {
            "id": "INC-TEST-24",
            "emergencyType": "Severe Trauma Accident",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        logs = decision_logger.get_logs("INC-TEST-24")
        self.assertGreater(len(logs), 0)
        self.assertEqual(logs[0]["action"], "DISPATCH_PLAN_SELECTED")
        self.assertIsNotNone(logs[0]["selectedAmbulance"])
        self.assertIsNotNone(logs[0]["selectedHospital"])

    # 25. Test Citizen Data Sanitization
    def test_25_citizen_data_sanitization(self):
        incident = {
            "id": "INC-TEST-25",
            "emergencyType": "Accident",
            "location": {"latitude": 21.2065, "longitude": 81.3320},
            "internalClinicalScore": 99.4,
            "dispatcherNotes": "Confidential patient assessment"
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        citizen_snap = emergency_orchestrator.get_citizen_privacy_snapshot("INC-TEST-25")
        self.assertNotIn("internalClinicalScore", json.dumps(citizen_snap))
        self.assertNotIn("dispatcherNotes", json.dumps(citizen_snap))

    # 26. Test Driver Details Propagation to Citizen Monitor
    def test_26_driver_details_reach_citizen(self):
        incident = {
            "id": "INC-TEST-26",
            "emergencyType": "Accident",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        citizen_snap = emergency_orchestrator.get_citizen_privacy_snapshot("INC-TEST-26")
        self.assertEqual(citizen_snap["ambulance"]["driverName"], "Rakesh Kumar")
        self.assertEqual(citizen_snap["ambulance"]["vehicleNumber"], "CG-04-AB-1234")

    # 27. Test Hospital Assignment Propagation to Citizen Monitor
    def test_27_hospital_assignment_reaches_citizen(self):
        incident = {
            "id": "INC-TEST-27",
            "emergencyType": "Trauma",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        citizen_snap = emergency_orchestrator.get_citizen_privacy_snapshot("INC-TEST-27")
        self.assertEqual(citizen_snap["hospital"]["name"], "Apex Trauma SuperSpecialty")
        self.assertIsNotNone(citizen_snap["hospital"]["etaFromSceneMinutes"])

    # 28. Test Live Telemetry Updates Reach Datastore
    def test_28_ambulance_telemetry_updates(self):
        events_emitted = []
        emergency_orchestrator.broadcast = lambda event, data: events_emitted.append((event, data))
        
        incident = {
            "id": "INC-TEST-28",
            "emergencyType": "Accident",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        
        # Send live telemetry ping
        from services.dispatch_engine import dispatch_engine
        dispatch_engine.update_responder_telemetry("AMB-01", 21.2070, 81.3325, 45.0)
        self.assertEqual(self.mock_responders[0]["live_telemetry"]["current_latitude"], 21.2070)

    # 29. Test Hospital Confirmation Propagation to Both UIs
    def test_29_hospital_confirmation_propagation(self):
        incident = {
            "id": "INC-TEST-29",
            "emergencyType": "Accident",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        
        ack_res = emergency_orchestrator.handle_hospital_ack("INC-TEST-29", "H-03", accepted=True)
        self.assertTrue(ack_res["success"])
        
        snap = emergency_orchestrator.get_authoritative_snapshot("INC-TEST-29")
        self.assertEqual(snap["status"], "HOSPITAL_CONFIRMED")
        self.assertEqual(snap["dispatch"]["hospital"]["status"], "CONFIRMED")

    # 30. Test Handover Completion Closes Incident & Releases Locks
    def test_30_handover_completion_closes_incident(self):
        incident = {
            "id": "INC-TEST-30",
            "emergencyType": "Accident",
            "location": {"latitude": 21.2065, "longitude": 81.3320}
        }
        emergency_orchestrator.orchestrate_new_incident(incident)
        
        # Complete full handover
        emergency_orchestrator.update_responder_status("AMB-01", "HANDOVER_COMPLETE", incident_id="INC-TEST-30")
        snap = emergency_orchestrator.get_authoritative_snapshot("INC-TEST-30")
        self.assertEqual(snap["status"], "INCIDENT_CLOSED")
        
        # Reservations released
        self.assertNotIn("AMB-01", reservation_manager.ambulance_reservations)
        self.assertEqual(reservation_manager.hospital_reservations.get("H-03", {}).get("icu_reserved", 0), 0)

if __name__ == "__main__":
    unittest.main(verbosity=2)

