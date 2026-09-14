"""
Master Dynamic Emergency Orchestrator for Rakshak 112.
Coordinates complete emergency response lifecycle: Patient + Ambulance + Hospital + Route.
Thread-safe, explainable, stateful, and resilient.
"""

import time
import threading
from typing import Dict, Any, List, Optional, Callable

from .state_machine import IncidentStateMachine
from .constraints import extract_medical_requirements
from .plan_evaluator import plan_evaluator
from .reservation_manager import reservation_manager
from .reoptimization_manager import reoptimization_manager
from .escalation_manager import escalation_manager
from .decision_log import decision_logger
from .snapshot_builder import snapshot_builder
from .confidence import evaluate_telemetry_freshness

class EmergencyOrchestrator:
    def __init__(
        self,
        event_broadcaster: Optional[Callable[[str, Any], None]] = None
    ):
        self.lock = threading.RLock()
        self.broadcast = event_broadcaster or (lambda event, data: None)
        
        # State stores
        self.hospitals: List[Dict[str, Any]] = []
        self.responders: List[Dict[str, Any]] = []
        self.incidents: List[Dict[str, Any]] = []

    def set_datasets(self, hospitals: List[Dict[str, Any]], responders: List[Dict[str, Any]], incidents: List[Dict[str, Any]]):
        with self.lock:
            self.hospitals = hospitals
            self.responders = responders
            self.incidents = incidents
            # Reconcile any existing reservations
            reservation_manager.reconcile_on_startup(incidents, responders, hospitals)

    def orchestrate_new_incident(self, incident: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes complete initial orchestration for an incoming SOS / incident.
        """
        with self.lock:
            if incident not in self.incidents:
                self.incidents.append(incident)
            inc_id = incident.get("id")
            now = time.time()
            now_ms = int(now * 1000)

            # 1. State machine: INCIDENT_CREATED -> ASSESSING
            IncidentStateMachine.apply_transition(incident, "INCIDENT_CREATED", "SOS beacon received and registered")
            
            # 2. Extract deterministic medical requirements
            medical_reqs = extract_medical_requirements(incident)
            incident["medicalRequirements"] = medical_reqs
            IncidentStateMachine.apply_transition(incident, "ASSESSING", "Clinical triage and resource requirements extracted")

            # 3. Evaluate Paired Response Plans (Ambulance A -> Hospital A, etc.)
            eval_res = plan_evaluator.evaluate_response_plans(
                incident=incident,
                responders=self.responders,
                hospitals=self.hospitals,
                medical_reqs=medical_reqs
            )

            if not eval_res.get("success"):
                err_code = eval_res.get("error", "DISPATCH_FAILED")
                IncidentStateMachine.apply_transition(incident, err_code, eval_res.get("message"))
                
                # Escalation trigger
                esc = escalation_manager.trigger_escalation(
                    incident=incident,
                    reason_code=err_code,
                    description=eval_res.get("message"),
                    attempted_actions=["EVALUATE_ALL_FLEET", "EVALUATE_ALL_HOSPITALS"]
                )
                
                decision_logger.log_decision(
                    incident_id=inc_id,
                    action=err_code,
                    dispatch_plan=None,
                    rejected_ambulances=eval_res.get("rejectedAmbulances", []),
                    rejected_hospitals=eval_res.get("rejectedHospitals", []),
                    reason=eval_res.get("message"),
                    trigger="INITIAL_DISPATCH_FAILURE"
                )
                
                self._broadcast_incident_event("incident:escalated", incident)
                return {
                    "success": False,
                    "error": err_code,
                    "incident": incident,
                    "escalation": esc,
                    "rejectedAmbulances": eval_res.get("rejectedAmbulances"),
                    "rejectedHospitals": eval_res.get("rejectedHospitals")
                }

            best_plan = eval_res["selectedPlan"]
            amb_id = best_plan["ambulanceId"]
            hosp_id = best_plan["hospitalId"]
            plan_id = best_plan["dispatchPlanId"]
            
            # 4. Atomically reserve ambulance
            amb_ok, amb_msg, amb_res_id = reservation_manager.reserve_ambulance_atomic(amb_id, inc_id, plan_id)
            if not amb_ok:
                # Retry evaluation once
                eval_res = plan_evaluator.evaluate_response_plans(incident, self.responders, self.hospitals, medical_reqs)
                if not eval_res.get("success"):
                    return {"success": False, "error": "AMBULANCE_LOCK_FAILED", "incident": incident}
                best_plan = eval_res["selectedPlan"]
                amb_id = best_plan["ambulanceId"]
                hosp_id = best_plan["hospitalId"]
                plan_id = best_plan["dispatchPlanId"]
                reservation_manager.reserve_ambulance_atomic(amb_id, inc_id, plan_id)

            IncidentStateMachine.apply_transition(incident, "AMBULANCE_RESERVED", f"Ambulance {amb_id} locked ({best_plan['responseEtaMinutes']}m ETA)")

            # 5. Atomically reserve hospital ICU/ER bed
            need_icu = medical_reqs.get("icu", False)
            hosp_obj = best_plan["hospital"]["hospital"]
            hosp_ok, hosp_msg, hosp_res_id = reservation_manager.reserve_hospital_atomic(
                hospital=hosp_obj,
                incident_id=inc_id,
                dispatch_plan_id=plan_id,
                need_icu=need_icu,
                need_er=True
            )
            IncidentStateMachine.apply_transition(incident, "HOSPITAL_SELECTED", f"Hospital {best_plan['hospital']['name']} selected (TTAC: {best_plan['ttacMinutes']}m)")

            # 6. Mark responder operational state
            amb_obj = best_plan["ambulance"]["ambulance"]
            amb_obj["status"] = "EN_ROUTE_TO_INCIDENT"
            amb_obj["operational_status"] = "EN_ROUTE_TO_INCIDENT"
            amb_obj["assigned_incident"] = inc_id

            # 7. Update incident authoritative structure
            incident["assignedAmbulance"] = amb_id
            incident["assignedAmbulanceDetails"] = best_plan["ambulance"]
            incident["destinationHospital"] = best_plan["hospital"]["name"]
            incident["hospitalId"] = hosp_id
            incident["destinationDetails"] = best_plan["hospital"]
            incident["dispatchPlanId"] = plan_id
            incident["ttac_minutes"] = best_plan["ttacMinutes"]
            incident["ttacMinutes"] = best_plan["ttacMinutes"]
            incident["ttacBreakdown"] = best_plan["ttacBreakdown"]
            incident["hospitalPreAlertStatus"] = "SENT"
            incident["planStatus"] = "ACTIVE"

            IncidentStateMachine.apply_transition(incident, "AMBULANCE_DISPATCHED", f"Ambulance {amb_id} dispatched")
            IncidentStateMachine.apply_transition(incident, "HOSPITAL_PREALERT_SENT", f"Pre-alert sent to {best_plan['hospital']['name']}")

            # 8. Record Explainable Decision Log
            dec_rec = decision_logger.log_decision(
                incident_id=inc_id,
                action="DISPATCH_PLAN_SELECTED",
                dispatch_plan=best_plan,
                rejected_ambulances=eval_res.get("rejectedAmbulances"),
                rejected_hospitals=eval_res.get("rejectedHospitals"),
                reason="Optimal compliant TTAC response plan",
                trigger="AUTO_DISPATCH"
            )
            incident["dispatchDecisionLog"] = decision_logger.get_logs(inc_id)

            # 9. Append authoritative timeline entries
            timeline = incident.setdefault("timeline", [])
            timeline.append({ "time": now_ms - 2000, "event": "Emergency SOS beacon received and registered" })
            timeline.append({ "time": now_ms - 1000, "event": f"Ambulance {amb_id} ({best_plan['ambulance']['driverName']}) reserved · ETA {best_plan['responseEtaMinutes']} min" })
            timeline.append({ "time": now_ms, "event": f"Pre-alert sent to {best_plan['hospital']['name']} · Estimated TTAC {best_plan['ttacMinutes']} min" })
            incident["transmissionTimeline"] = timeline

            # 10. Broadcast authoritative events to Control Room & Citizen Monitor via SSE
            self._broadcast_incident_event("incident:created", incident)
            self._broadcast_incident_event("incident.created", incident)
            self._broadcast_incident_event("incident:update", incident)
            self._broadcast_incident_event("ambulance:reserved", { "incident_id": inc_id, "ambulance_id": amb_id, "eta_minutes": best_plan["responseEtaMinutes"] })
            self._broadcast_incident_event("hospital:prealert", { "incident_id": inc_id, "hospital_id": hosp_id, "hospital_name": best_plan["hospital"]["name"], "ttac": best_plan["ttacMinutes"] })

            return {
                "success": True,
                "incident": incident,
                "dispatch_plan": best_plan,
                "dispatchPlan": best_plan,
                "dispatch": best_plan,
                "decision": dec_rec
            }

    def reevaluate_incident(self, incident_id: str, trigger_event: str = "STATE_CHANGE") -> Dict[str, Any]:
        """
        Dynamically re-evaluates active response plan. Applies hysteresis and lifecycle rules.
        """
        with self.lock:
            incident = next((i for i in self.incidents if i.get("id") == incident_id), None)
            if not incident:
                return { "success": False, "error": "INCIDENT_NOT_FOUND" }

            curr_status = incident.get("status")
            if curr_status in ("INCIDENT_CLOSED", "CANCELLED", "HANDOVER_COMPLETE"):
                return { "success": False, "error": "INCIDENT_ALREADY_CLOSED" }

            now = time.time()
            now_ms = int(now * 1000)
            curr_ttac = float(incident.get("ttac_minutes") or incident.get("ttacMinutes") or 999.0)
            curr_hosp_id = incident.get("hospitalId")
            
            medical_reqs = incident.get("medicalRequirements") or extract_medical_requirements(incident)
            incident["medicalRequirements"] = medical_reqs

            # Re-evaluate complete plans
            eval_res = plan_evaluator.evaluate_response_plans(incident, self.responders, self.hospitals, medical_reqs)
            if not eval_res.get("success"):
                return { "success": False, "error": eval_res.get("error"), "incident": incident }

            cand_plan = eval_res["selectedPlan"]
            cand_ttac = float(cand_plan["ttacMinutes"])
            cand_hosp_id = cand_plan["hospitalId"]
            
            # Check if current hospital has diverted
            curr_hosp = next((h for h in self.hospitals if h.get("id") == curr_hosp_id), None)
            is_diverted = False
            if curr_hosp:
                l = curr_hosp.get("live_status", {})
                if l.get("accepting_emergency") is False or l.get("intake_status") == "DIVERTED":
                    is_diverted = True

            should_switch = reoptimization_manager.should_reoptimize(
                incident=incident,
                trigger_event=trigger_event,
                current_ttac=curr_ttac,
                candidate_ttac=cand_ttac,
                is_hospital_diverted=is_diverted
            )
            reason = f"Operational state change: {trigger_event}"

            if should_switch and (cand_hosp_id != curr_hosp_id or cand_plan["ambulanceId"] != incident.get("assignedAmbulance")):
                old_hosp_name = incident.get("destinationHospital")
                
                # Release old hospital reservation & reserve new
                reservation_manager.release_hospital_reservation(incident_id)
                need_icu = medical_reqs.get("icu", False)
                reservation_manager.reserve_hospital_atomic(
                    hospital=cand_plan["hospital"]["hospital"],
                    incident_id=incident_id,
                    dispatch_plan_id=cand_plan["dispatchPlanId"],
                    need_icu=need_icu,
                    need_er=True
                )

                # If ambulance changed, reserve new ambulance
                if cand_plan["ambulanceId"] != incident.get("assignedAmbulance"):
                    reservation_manager.reserve_ambulance_atomic(
                        cand_plan["ambulanceId"],
                        incident_id,
                        cand_plan["dispatchPlanId"]
                    )
                    incident["assignedAmbulance"] = cand_plan["ambulanceId"]
                    incident["assignedAmbulanceDetails"] = cand_plan["ambulance"]

                # Update incident state
                incident["destinationHospital"] = cand_plan["hospital"]["name"]
                incident["hospitalId"] = cand_hosp_id
                incident["destinationDetails"] = cand_plan["hospital"]
                incident["dispatchPlanId"] = cand_plan["dispatchPlanId"]
                incident["ttac_minutes"] = cand_ttac
                incident["ttacMinutes"] = cand_ttac
                incident["ttacBreakdown"] = cand_plan["ttacBreakdown"]

                # Log re-optimization decision
                dec_rec = decision_logger.log_decision(
                    incident_id=incident_id,
                    action="DISPATCH_PLAN_REOPTIMIZED",
                    dispatch_plan=cand_plan,
                    rejected_ambulances=eval_res.get("rejectedAmbulances"),
                    rejected_hospitals=eval_res.get("rejectedHospitals"),
                    reason=reason,
                    trigger=trigger_event
                )
                incident["dispatchDecisionLog"] = decision_logger.get_logs(incident_id)

                timeline = incident.setdefault("timeline", [])
                timeline.append({
                    "time": now_ms,
                    "event": f"Response plan reoptimized: destination updated to {cand_plan['hospital']['name']} ({reason})"
                })
                incident["transmissionTimeline"] = timeline

                self._broadcast_incident_event("dispatch:reoptimized", {
                    "incident_id": incident_id,
                    "previous_hospital": old_hosp_name,
                    "new_hospital": cand_plan["hospital"]["name"],
                    "new_ttac": cand_ttac,
                    "reason": reason,
                    "incident": incident
                })
                self._broadcast_incident_event("incident:update", incident)

                return { "success": True, "reoptimized": True, "incident": incident, "decision": dec_rec }

            return { "success": True, "reoptimized": False, "reason": reason, "incident": incident }

    def handle_hospital_ack(self, incident_id: str, hospital_id: str, accepted: bool, reason: str = "") -> Dict[str, Any]:
        """
        Handles pre-alert acknowledgement or rejection from hospital emergency intake.
        """
        with self.lock:
            incident = next((i for i in self.incidents if i.get("id") == incident_id), None)
            if not incident:
                return { "success": False, "error": "INCIDENT_NOT_FOUND" }

            now_ms = int(time.time() * 1000)
            timeline = incident.setdefault("timeline", [])

            if accepted:
                IncidentStateMachine.apply_transition(incident, "HOSPITAL_CONFIRMED", f"Hospital {hospital_id} confirmed reception and reserved ICU/ER bed")
                if incident.get("destinationDetails"):
                    incident["destinationDetails"]["reservation_state"] = "CONFIRMED"
                timeline.append({
                    "time": now_ms,
                    "event": f"✓ Hospital {incident.get('destinationHospital', hospital_id)} confirmed readiness · Bed reserved"
                })
                self._broadcast_incident_event("hospital:confirmed", { "incident_id": incident_id, "hospital_id": hospital_id })
                self._broadcast_incident_event("incident:update", incident)
                return { "success": True, "status": "HOSPITAL_CONFIRMED", "incident": incident }
            else:
                incident.setdefault("rejectedHospitalsList", []).append(hospital_id)
                IncidentStateMachine.apply_transition(incident, "HOSPITAL_REJECTED", f"Hospital {hospital_id} rejected pre-alert: {reason}")
                timeline.append({
                    "time": now_ms,
                    "event": f"⚠ Hospital {hospital_id} declined pre-alert ({reason}) · Re-routing to next best facility"
                })
                self._broadcast_incident_event("hospital:rejected", { "incident_id": incident_id, "hospital_id": hospital_id, "reason": reason })
                
                # Immediate re-optimization bypasses hysteresis
                reopt_res = self.reevaluate_incident(incident_id, trigger_event="HOSPITAL_REJECTED")
                return { "success": True, "reoptimized": True, "status": "HOSPITAL_REJECTED", "reoptimization": reopt_res, "incident": incident }

    def update_responder_status(self, responder_id: str, new_status: str, incident_id: str = None) -> Dict[str, Any]:
        """
        Handles operational responder status changes (e.g. AT_SCENE, PATIENT_ON_BOARD, AT_HOSPITAL, BREAKDOWN).
        """
        with self.lock:
            resp = next((r for r in self.responders if (r.get("unit_id") == responder_id or r.get("id") == responder_id)), None)
            if resp:
                resp["status"] = new_status
                resp["operational_status"] = new_status
                
            # Find associated incident
            target_inc = None
            if incident_id:
                target_inc = next((i for i in self.incidents if i.get("id") == incident_id), None)
            else:
                target_inc = next((i for i in self.incidents if i.get("assignedAmbulance") == responder_id), None)

            if not target_inc:
                return { "success": True, "reoptimized": False, "responder": resp, "incident": None }

            inc_id = target_inc.get("id")
            now_ms = int(time.time() * 1000)
            timeline = target_inc.setdefault("timeline", [])
            is_reopt = False

            # Map responder status to incident state
            if new_status in ("ON_SCENE", "AT_SCENE"):
                IncidentStateMachine.apply_transition(target_inc, "AMBULANCE_AT_SCENE", f"Ambulance {responder_id} arrived at emergency scene")
                timeline.append({ "time": now_ms, "event": f"Ambulance {responder_id} arrived on scene" })
            elif new_status == "PATIENT_ON_BOARD":
                IncidentStateMachine.apply_transition(target_inc, "PATIENT_ON_BOARD", "Patient safely boarded into ambulance")
                timeline.append({ "time": now_ms, "event": f"Patient boarded into ambulance · En route to {target_inc.get('destinationHospital')}" })
                IncidentStateMachine.apply_transition(target_inc, "EN_ROUTE_TO_HOSPITAL", f"En route to {target_inc.get('destinationHospital')}")
            elif new_status in ("AT_HOSPITAL", "ARRIVED_HOSPITAL"):
                IncidentStateMachine.apply_transition(target_inc, "AT_HOSPITAL", f"Ambulance arrived at {target_inc.get('destinationHospital')}")
                timeline.append({ "time": now_ms, "event": f"Ambulance arrived at {target_inc.get('destinationHospital')} emergency bay" })
            elif new_status == "HANDOVER_COMPLETE":
                IncidentStateMachine.apply_transition(target_inc, "HANDOVER_COMPLETE", "Clinical handover to hospital trauma team completed")
                timeline.append({ "time": now_ms, "event": "Clinical handover completed · Incident resolved" })
                reservation_manager.release_all_incident_reservations(inc_id)
                IncidentStateMachine.apply_transition(target_inc, "INCIDENT_CLOSED", "Incident closed")
            elif new_status in ("BREAKDOWN", "OFFLINE", "FAILURE"):
                is_reopt = True
                IncidentStateMachine.apply_transition(target_inc, "AMBULANCE_FAILURE", f"Ambulance {responder_id} failed / breakdown reported")
                timeline.append({ "time": now_ms, "event": f"⚠ Ambulance {responder_id} breakdown reported · Requesting immediate replacement" })
                reservation_manager.release_all_incident_reservations(inc_id)
                self.reevaluate_incident(inc_id, trigger_event="AMBULANCE_BREAKDOWN")

            self._broadcast_incident_event("incident:update", target_inc)
            return { "success": True, "reoptimized": is_reopt, "responder": resp, "incident": target_inc }

    def apply_dispatcher_override(
        self,
        incident_id: str,
        ambulance_id: str = None,
        hospital_id: str = None,
        dispatcher_name: str = "Dispatcher (Manual Override)",
        reason: str = "Operational discretion"
    ) -> Dict[str, Any]:
        """
        Allows human dispatcher to override automated plan while preserving full decision audit trail.
        """
        with self.lock:
            incident = next((i for i in self.incidents if i.get("id") == incident_id), None)
            if not incident:
                return { "success": False, "error": "INCIDENT_NOT_FOUND" }

            old_amb = incident.get("assignedAmbulance")
            old_hosp = incident.get("hospitalId")
            now_ms = int(time.time() * 1000)

            if ambulance_id and ambulance_id != old_amb:
                reservation_manager.release_all_incident_reservations(incident_id)
                reservation_manager.reserve_ambulance_atomic(ambulance_id, incident_id, f"OVERRIDE-{incident_id}")
                incident["assignedAmbulance"] = ambulance_id

            if hospital_id and hospital_id != old_hosp:
                reservation_manager.release_hospital_reservation(incident_id)
                hosp_obj = next((h for h in self.hospitals if h.get("id") == hospital_id or h.get("name") == hospital_id or h.get("hospital_name") == hospital_id), None)
                if hosp_obj:
                    reservation_manager.reserve_hospital_atomic(hosp_obj, incident_id, f"OVERRIDE-{incident_id}")
                    incident["hospitalId"] = hospital_id
                    incident["destinationHospital"] = hosp_obj.get("name") or hosp_obj.get("hospital_name", hospital_id)

            dec_rec = decision_logger.log_decision(
                incident_id=incident_id,
                action="MANUAL_OVERRIDE",
                dispatch_plan=None,
                reason=f"Manual override by {dispatcher_name}: {reason}",
                trigger="HUMAN_OVERRIDE"
            )
            incident["dispatchDecisionLog"] = decision_logger.get_logs(incident_id)

            timeline = incident.setdefault("timeline", [])
            timeline.append({
                "time": now_ms,
                "event": f"⚡ Dispatcher override applied ({dispatcher_name}) · {reason}"
            })
            incident["transmissionTimeline"] = timeline

            self._broadcast_incident_event("incident:overridden", { "incident": incident, "reason": reason, "dispatcher": dispatcher_name })
            self._broadcast_incident_event("incident:update", incident)

            return { "success": True, "incident": incident, "decision": dec_rec }

    def get_authoritative_snapshot(self, incident_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            incident = next((i for i in self.incidents if i.get("id") == incident_id), None)
            if not incident:
                return None
            decisions = decision_logger.get_logs(incident_id)
            return snapshot_builder.build_authoritative_snapshot(incident, decisions)

    def get_citizen_privacy_snapshot(self, incident_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            auth_snap = self.get_authoritative_snapshot(incident_id)
            if not auth_snap:
                return None
            return snapshot_builder.build_citizen_privacy_snapshot(auth_snap)

    def _broadcast_incident_event(self, event_type: str, incident_or_payload: Any):
        """Helper to broadcast SSE with stateVersion."""
        state_ver = 1
        inc_id = ""
        if isinstance(incident_or_payload, dict):
            state_ver = incident_or_payload.get("stateVersion", 1)
            inc_id = incident_or_payload.get("id") or incident_or_payload.get("incidentId") or incident_or_payload.get("incident_id") or ""
            
        payload = {
            "eventId": f"EVT-{int(time.time() * 1000 % 1000000):06d}",
            "incidentId": inc_id,
            "type": event_type,
            "timestamp": int(time.time() * 1000),
            "stateVersion": state_ver,
            "data": incident_or_payload
        }
        self.broadcast(event_type, payload)
        self.broadcast("incident", incident_or_payload)

# Singleton master instance
emergency_orchestrator = EmergencyOrchestrator()
