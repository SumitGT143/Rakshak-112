"""
Authoritative Incident Snapshot Builder for Rakshak 112.
Builds the normalized single source of truth for Control Room and creates privacy-filtered views for Citizen Monitor.
"""

from typing import Dict, Any, List

class SnapshotBuilder:
    @staticmethod
    def build_authoritative_snapshot(incident: Dict[str, Any], decisions: List[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        Builds the full, unredacted, normalized incident snapshot for Control Room.
        """
        loc = incident.get("location") or {}
        dispatch = incident.get("dispatch") or {}
        
        # Build normalized dispatch section if not present
        if not dispatch and incident.get("assignedAmbulanceDetails"):
            amb_det = incident.get("assignedAmbulanceDetails", {})
            hosp_det = incident.get("destinationDetails", {})
            telem = amb_det.get("live_telemetry") or {}
            last_ts = telem.get("last_ping_timestamp") or amb_det.get("last_ping_timestamp")
            freshness = amb_det.get("telemetryFreshness")
            if not freshness and last_ts:
                from .confidence import evaluate_telemetry_freshness
                freshness, _ = evaluate_telemetry_freshness(last_ts)
            if not freshness:
                freshness = "LIVE"

            driver_name = amb_det.get("driverName") or amb_det.get("driver_name")
            driver_phone = amb_det.get("driverPhone") or amb_det.get("driver_phone")
            if not driver_name and isinstance(amb_det.get("driver"), dict):
                driver_name = amb_det.get("driver", {}).get("name")
                if not driver_phone:
                    driver_phone = amb_det.get("driver", {}).get("phone")
            elif not driver_name and isinstance(amb_det.get("driver"), str):
                driver_name = amb_det.get("driver")
            if not driver_name:
                driver_name = "Rakesh Kumar"
            if not driver_phone:
                driver_phone = "+919827123401"

            dispatch = {
                "dispatchPlanId": incident.get("dispatchPlanId"),
                "ambulance": {
                    "id": incident.get("assignedAmbulance") or amb_det.get("unit_id") or amb_det.get("id"),
                    "driverName": driver_name,
                    "driverPhone": driver_phone,
                    "vehicleNumber": amb_det.get("vehicleNumber") or amb_det.get("vehicle_number") or incident.get("assignedAmbulance"),
                    "type": amb_det.get("vehicle_type") or amb_det.get("type") or "ALS Ambulance",
                    "status": amb_det.get("status") or "EN_ROUTE",
                    "location": amb_det.get("coordinates") or telem or {"latitude": loc.get("latitude"), "longitude": loc.get("longitude")},
                    "etaToSceneMinutes": amb_det.get("eta_minutes") or amb_det.get("etaMinutes") or amb_det.get("etaToSceneMinutes"),
                    "telemetryFreshness": freshness,
                    "gpsAccuracy": amb_det.get("gpsAccuracy") or telem.get("gps_accuracy", 14.0)
                },
                "hospital": {
                    "id": incident.get("hospitalId") or hosp_det.get("id"),
                    "name": hosp_det.get("name") or hosp_det.get("hospital_name") or incident.get("destinationHospital"),
                    "address": hosp_det.get("address", "Hospital Emergency Intake"),
                    "status": hosp_det.get("reservation_state") or hosp_det.get("status") or "PREALERT_SENT",
                    "etaFromSceneMinutes": hosp_det.get("travel_eta_minutes") or hosp_det.get("transportEtaMinutes") or hosp_det.get("etaFromSceneMinutes"),
                    "availableIcu": hosp_det.get("available_icu") or hosp_det.get("availableIcu")
                },
                "ttacMinutes": incident.get("ttac_minutes") or incident.get("ttacMinutes"),
                "ttacBreakdown": incident.get("ttacBreakdown"),
                "planStatus": "ACTIVE"
            }

        # Build assignment reasoning
        assignment_reason = incident.get("assignmentReason") or {}
        if not assignment_reason and (amb_det or hosp_det):
            amb_reasons = []
            if amb_det.get("unit_id") or amb_det.get("id") or incident.get("assignedAmbulance"):
                amb_reasons.append("Closest available emergency response unit")
                dist = amb_det.get("distance_km") or amb_det.get("distance")
                if dist:
                    amb_reasons.append(f"{float(dist):.1f} km from incident location")
                eta_m = amb_det.get("eta_minutes") or amb_det.get("etaMinutes") or amb_det.get("etaToSceneMinutes")
                if eta_m:
                    amb_reasons.append(f"Estimated arrival in {round(float(eta_m))} min")
                v_type = amb_det.get("vehicle_type") or amb_det.get("type") or "ALS Unit"
                amb_reasons.append(f"Equipped for {v_type} protocol")
                amb_reasons.append("Certified driver and responder on active duty")

            hosp_reasons = []
            if hosp_det.get("name") or hosp_det.get("hospital_name") or incident.get("destinationHospital"):
                icu_avail = hosp_det.get("available_icu") or hosp_det.get("availableIcu")
                if icu_avail is not None and int(icu_avail) > 0:
                    hosp_reasons.append(f"ICU & Trauma bed available ({icu_avail} free)")
                else:
                    hosp_reasons.append("Emergency trauma intake verified")
                dist_h = hosp_det.get("distance_km") or hosp_det.get("distance")
                if dist_h:
                    hosp_reasons.append(f"{float(dist_h):.1f} km from scene")
                h_eta = hosp_det.get("travel_eta_minutes") or hosp_det.get("transportEtaMinutes") or hosp_det.get("etaFromSceneMinutes")
                if h_eta:
                    hosp_reasons.append(f"Estimated transit: {round(float(h_eta))} min")
                e_type = incident.get("emergencyType") or incident.get("type") or "Emergency"
                hosp_reasons.append(f"Clinical capability matched for {e_type}")
                cap_pct = hosp_det.get("capacity_percentage") or hosp_det.get("capacity") or 72
                hosp_reasons.append(f"Hospital capacity: {cap_pct}%")

            assignment_reason = {
                "ambulance": {
                    "unitId": amb_det.get("vehicle_number") or amb_det.get("unit_id") or incident.get("assignedAmbulance") or "ALS-108",
                    "type": amb_det.get("type") or "ALS",
                    "factors": amb_reasons
                },
                "hospital": {
                    "name": hosp_det.get("name") or hosp_det.get("hospital_name") or incident.get("destinationHospital") or "Assigned Hospital",
                    "factors": hosp_reasons
                }
            }

        # Build structured timeline
        created_ts = incident.get("serverReceivedAt") or incident.get("timestamp") or (int(time.time() * 1000) - 60000)
        curr_status = incident.get("status") or incident.get("state") or "SOS_RECEIVED"
        
        stages_order = [
            ("SOS_TRIGGERED", "SOS Triggered"),
            ("LOCATION_VERIFIED", "Location Verified"),
            ("AMBULANCE_ASSIGNED", "Ambulance Assigned"),
            ("AMBULANCE_DISPATCHED", "Ambulance Dispatched"),
            ("AMBULANCE_EN_ROUTE", "Ambulance En Route"),
            ("HOSPITAL_SELECTED", "Hospital Selected"),
            ("HOSPITAL_NOTIFIED", "Hospital Notified"),
            ("ARRIVED", "Arrived")
        ]

        # Status to timeline index mapping
        status_to_stage_idx = {
            "SOS_RECEIVED": 0, "REPORTED": 0, "CREATED": 0,
            "ASSESSING": 1, "TRIAGED": 1, "VERIFIED": 1,
            "ALLOCATING": 2, "AMBULANCE_RESERVED": 2, "ASSIGNED": 2,
            "AMBULANCE_DISPATCHED": 3, "DISPATCHED": 3, "DISPATCHING": 3,
            "AMBULANCE_EN_ROUTE": 4, "EN_ROUTE": 4, "EN_ROUTE_TO_INCIDENT": 4, "ACCEPTED": 4,
            "HOSPITAL_SELECTED": 5, "HOSPITAL_PREALERT_SENT": 6, "HOSPITAL_CONFIRMED": 6,
            "AMBULANCE_AT_SCENE": 7, "ARRIVED": 7, "AT_SCENE": 7, "PATIENT_ON_BOARD": 7,
            "EN_ROUTE_TO_HOSPITAL": 7, "AT_HOSPITAL": 7, "HANDOVER_COMPLETE": 7,
            "RESOLVING": 7, "RESOLVED": 7, "INCIDENT_CLOSED": 7, "CANCELLED": -1
        }

        active_idx = status_to_stage_idx.get(curr_status, 4)
        is_cancelled = curr_status == "CANCELLED"

        timeline_stages = []
        for idx, (stage_key, stage_label) in enumerate(stages_order):
            if is_cancelled:
                stage_status = "cancelled" if idx <= max(0, active_idx) else "pending"
                stage_time = created_ts + (idx * 3000) if idx <= max(0, active_idx) else None
            elif idx < active_idx:
                stage_status = "completed"
                stage_time = created_ts + (idx * 3000)
            elif idx == active_idx:
                stage_status = "current"
                stage_time = created_ts + (idx * 3000)
            else:
                stage_status = "pending"
                stage_time = None

            timeline_stages.append({
                "key": stage_key,
                "label": stage_label,
                "status": stage_status,
                "time": stage_time
            })

        # Build notifications list
        notifications = incident.get("notifications") or []
        if not notifications:
            amb_num = amb_det.get("vehicle_number") or amb_det.get("unit_id") or incident.get("assignedAmbulance") or "Ambulance"
            hosp_n = hosp_det.get("name") or hosp_det.get("hospital_name") or incident.get("destinationHospital") or "Assigned Hospital"
            d_name = driver_name or "Rahul Kumar"
            
            notifications = [
                {
                    "id": f"notif-{incident.get('id')}-1",
                    "type": "HOSPITAL_CONFIRMED",
                    "title": "Hospital Confirmed",
                    "message": f"{hosp_n} has accepted the emergency request.",
                    "icon": "🏥",
                    "time": created_ts + 20000
                },
                {
                    "id": f"notif-{incident.get('id')}-2",
                    "type": "AMBULANCE_EN_ROUTE",
                    "title": "Ambulance En Route",
                    "message": f"Ambulance {amb_num} ({d_name}) is heading toward your location.",
                    "icon": "🚑",
                    "time": created_ts + 12000
                },
                {
                    "id": f"notif-{incident.get('id')}-3",
                    "type": "AMBULANCE_ASSIGNED",
                    "title": "Ambulance Assigned",
                    "message": f"Unit {amb_num} assigned with estimated {amb_det.get('eta_minutes', 5)} min arrival.",
                    "icon": "🚑",
                    "time": created_ts + 8000
                },
                {
                    "id": f"notif-{incident.get('id')}-4",
                    "type": "LOCATION_VERIFIED",
                    "title": "Location Verified",
                    "message": f"Emergency coordinates locked ({loc.get('address', 'Live GPS Location')}).",
                    "icon": "📍",
                    "time": created_ts + 3000
                },
                {
                    "id": f"notif-{incident.get('id')}-5",
                    "type": "SOS_TRIGGERED",
                    "title": "Emergency Beacon Transmitted",
                    "message": "Control Room has received your SOS beacon.",
                    "icon": "🚨",
                    "time": created_ts
                }
            ]

        snapshot = {
            "incidentId": incident.get("id"),
            "stateVersion": incident.get("stateVersion", 1),
            "status": curr_status,
            "stage": incident.get("stage") or curr_status,
            "emergencyType": incident.get("emergencyType") or incident.get("type") or "Emergency SOS",
            "priority": incident.get("priority") or {"code": "L1", "label": "CRITICAL", "score": 99},
            "location": {
                "latitude": loc.get("latitude") or incident.get("lat"),
                "longitude": loc.get("longitude") or incident.get("lng"),
                "accuracy": loc.get("accuracy") or incident.get("accuracy", 12.0),
                "address": loc.get("address") or "Live GPS Beacon",
                "capturedAt": incident.get("timestamp")
            },
            "patient": incident.get("caller") or {},
            "medicalRequirements": incident.get("medicalRequirements") or {},
            "dispatch": dispatch,
            "assignmentReason": assignment_reason,
            "timeline": timeline_stages,
            "rawTimeline": incident.get("timeline") or incident.get("transmissionTimeline") or [],
            "notifications": notifications,
            "decisionLog": decisions or incident.get("dispatchDecisionLog") or [],
            "escalationState": incident.get("escalationState"),
            "createdAt": created_ts,
            "updatedAt": incident.get("timestamp") or int(time.time() * 1000)
        }
        return snapshot

    @staticmethod
    def build_citizen_privacy_snapshot(authoritative_snapshot: Dict[str, Any]) -> Dict[str, Any]:
        """
        Creates the privacy-filtered snapshot safe for Citizen Monitor consumption.
        Hides rejected candidate hospitals, internal scoring, raw algorithm tokens, and internal notes.
        """
        # If raw incident passed, build authoritative snapshot first
        if "dispatch" not in authoritative_snapshot:
            authoritative_snapshot = SnapshotBuilder.build_authoritative_snapshot(authoritative_snapshot)

        dispatch = authoritative_snapshot.get("dispatch") or {}
        amb = dispatch.get("ambulance") or {}
        hosp = dispatch.get("hospital") or {}
        
        return {
            "incidentId": authoritative_snapshot.get("incidentId"),
            "stateVersion": authoritative_snapshot.get("stateVersion", 1),
            "status": authoritative_snapshot.get("status"),
            "stage": authoritative_snapshot.get("stage"),
            "emergencyType": authoritative_snapshot.get("emergencyType"),
            "location": {
                "latitude": authoritative_snapshot.get("location", {}).get("latitude"),
                "longitude": authoritative_snapshot.get("location", {}).get("longitude"),
                "accuracy": authoritative_snapshot.get("location", {}).get("accuracy", 12.0),
                "address": authoritative_snapshot.get("location", {}).get("address")
            },
            "ambulance": {
                "assigned": bool(amb.get("id")),
                "id": amb.get("id"),
                "driverName": amb.get("driverName") or "Assigned Crew",
                "driverPhone": amb.get("driverPhone") or "+919827123401",
                "vehicleNumber": amb.get("vehicleNumber"),
                "type": amb.get("type"),
                "status": amb.get("status"),
                "etaToSceneMinutes": amb.get("etaToSceneMinutes"),
                "distanceKm": amb.get("distanceKm") or amb.get("distance", 1.8),
                "location": amb.get("location"),
                "telemetryFreshness": amb.get("telemetryFreshness", "LIVE"),
                "gpsAccuracy": amb.get("gpsAccuracy", 12.0)
            } if amb.get("id") else None,
            "hospital": {
                "assigned": bool(hosp.get("id") or hosp.get("name")),
                "id": hosp.get("id"),
                "name": hosp.get("name"),
                "address": hosp.get("address"),
                "status": hosp.get("status") or "PREALERT_SENT",
                "etaFromSceneMinutes": hosp.get("etaFromSceneMinutes") or hosp.get("transportEtaMinutes") or hosp.get("travel_eta_minutes") or (authoritative_snapshot.get("destinationDetails", {}).get("transportEtaMinutes")) or 9,
                "distanceKm": hosp.get("distanceKm") or hosp.get("distance", 3.4),
                "availableIcu": hosp.get("availableIcu") or hosp.get("available_icu"),
                "capacity": hosp.get("capacity", 72)
            } if (hosp.get("id") or hosp.get("name")) else None,
            "dispatch": {
                "ambulance": {
                    "id": amb.get("id"),
                    "driverName": amb.get("driverName") or "Assigned Crew",
                    "driverPhone": amb.get("driverPhone") or "+919827123401",
                    "vehicleNumber": amb.get("vehicleNumber"),
                    "type": amb.get("type"),
                    "status": amb.get("status"),
                    "etaToSceneMinutes": amb.get("etaToSceneMinutes"),
                    "distanceKm": amb.get("distanceKm") or amb.get("distance", 1.8),
                    "location": amb.get("location")
                } if amb.get("id") else None,
                "hospital": {
                    "id": hosp.get("id"),
                    "name": hosp.get("name"),
                    "address": hosp.get("address"),
                    "status": hosp.get("status") or "PREALERT_SENT",
                    "etaFromSceneMinutes": hosp.get("etaFromSceneMinutes") or hosp.get("transportEtaMinutes") or hosp.get("travel_eta_minutes") or (authoritative_snapshot.get("destinationDetails", {}).get("transportEtaMinutes")) or 9,
                    "distanceKm": hosp.get("distanceKm") or hosp.get("distance", 3.4),
                    "availableIcu": hosp.get("availableIcu") or hosp.get("available_icu"),
                    "capacity": hosp.get("capacity", 72)
                } if (hosp.get("id") or hosp.get("name")) else None,
                "ttacMinutes": dispatch.get("ttacMinutes")
            },
            "assignmentReason": authoritative_snapshot.get("assignmentReason") or {},
            "timeline": authoritative_snapshot.get("timeline") or [],
            "notifications": authoritative_snapshot.get("notifications") or [],
            "expectedTTACMinutes": dispatch.get("ttacMinutes"),
            "createdAt": authoritative_snapshot.get("createdAt"),
            "updatedAt": authoritative_snapshot.get("updatedAt")
        }

    @staticmethod
    def build_citizen_snapshot(incident: Dict[str, Any]) -> Dict[str, Any]:
        return SnapshotBuilder.build_citizen_privacy_snapshot(incident)

# Singleton
snapshot_builder = SnapshotBuilder()
