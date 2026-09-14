#!/usr/bin/env python3
"""
Rakshak 112 — Dynamic Constraint-Aware Emergency Dispatch Backend & Multi-App Server
Provides full REST API, Server-Sent Events (SSE) live streaming,
Coordinated Dispatch Engine (Patient + Ambulance + Hospital + Route),
Atomic Resource Locking (ICU / ER / Fleet), and Two-Way Live Control Room Bridge.
"""

import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")
import time
import json
import socket
import threading
import webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = CURRENT_DIR


# Ensure services directory is in sys.path
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

import queue
from services.route_service import route_service, haversine_distance
from services.resource_manager import resource_manager
from services.ambulance_matcher import ambulance_matcher
from services.hospital_matcher import hospital_matcher, build_medical_requirements
from services.dispatch_engine import dispatch_engine

# Active SSE client queues
sse_client_queues = []
sse_lock = threading.Lock()

def broadcast_sse(event_name, data):
    payload = f"event: {event_name}\ndata: {json.dumps(data)}\n\n".encode('utf-8')
    with sse_lock:
        for q in list(sse_client_queues):
            try:
                q.put_nowait(payload)
            except Exception:
                pass

# Connect dispatch engine broadcaster
dispatch_engine.broadcast = broadcast_sse

# Global In-Memory Datastores
hospitals_db = []
responders_db = []
incidents_db = [
    {
        "id": "INC-204",
        "emergencyType": "Road Traffic Accident (Polytrauma)",
        "type": "Road Traffic Accident (Polytrauma)",
        "priority": { "code": "L1", "label": "CRITICAL", "score": 98 },
        "location": { "latitude": 21.2065, "longitude": 81.3320, "address": "GE Road, Supela Chowk, Bhilai" },
        "lat": 21.2065,
        "lng": 81.3320,
        "status": "RPT",
        "state": "REPORTED",
        "timestamp": int(time.time() * 1000) - 180000,
        "triage": { "injuredCount": 2, "consciousness": "1 Unresponsive", "severeBleeding": True },
        "caller": { "name": "Rohan Sharma (Bystander)", "phone": "+91 98271 55432" },
        "responseNote": "2 casualties. Motorbike vs SUV. Head trauma and fracture. ALS unit AMB-108-01 en route."
    }
]

def load_initial_datasets():
    global hospitals_db, responders_db
    
    # Load Hospitals
    h_combined = []
    raipur_hosp = os.path.join(CURRENT_DIR, "RAIPUR HOSPITAL.JSON")
    durg_hosp = os.path.join(CURRENT_DIR, "DURG HOSPITAL.JSON")

    if os.path.exists(raipur_hosp):
        try:
            with open(raipur_hosp, 'r', encoding='utf-8') as f:
                d = json.load(f)
                h_list = d.get('hospitals', [])
                for h in h_list:
                    if 'district' not in h:
                        h['district'] = 'Raipur'
                h_combined.extend(h_list)
        except Exception as e:
            print(f"Error loading {raipur_hosp}: {e}")

    if os.path.exists(durg_hosp):
        try:
            with open(durg_hosp, 'r', encoding='utf-8') as f:
                d = json.load(f)
                h_list = d.get('hospitals', [])
                for h in h_list:
                    if 'district' not in h:
                        h['district'] = 'Durg'
                h_combined.extend(h_list)
        except Exception as e:
            print(f"Error loading {durg_hosp}: {e}")

    hospitals_db = h_combined

    # Load Responders
    r_combined = []
    raipur_resp = os.path.join(CURRENT_DIR, "raipur_responders_fleet_database.json")
    durg_resp = os.path.join(CURRENT_DIR, "durg_responders_fleet_database.json")

    if os.path.exists(raipur_resp):
        try:
            with open(raipur_resp, 'r', encoding='utf-8') as f:
                d = json.load(f)
                resp_list = d.get('responders', [])
                for r in resp_list:
                    if 'district' not in r:
                        r['district'] = 'Raipur'
                r_combined.extend(resp_list)
        except Exception as e:
            print(f"Error loading {raipur_resp}: {e}")

    if os.path.exists(durg_resp):
        try:
            with open(durg_resp, 'r', encoding='utf-8') as f:
                d = json.load(f)
                resp_list = d.get('responders', [])
                for r in resp_list:
                    if 'district' not in r:
                        r['district'] = 'Durg'
                r_combined.extend(resp_list)
        except Exception as e:
            print(f"Error loading {durg_resp}: {e}")

    responders_db = r_combined
    
    # Sync with dispatch engine
    dispatch_engine.set_datasets(hospitals_db, responders_db, incidents_db)
    print(f"✅ Loaded {len(hospitals_db)} hospitals and {len(responders_db)} responders into Dynamic Dispatch Engine.")

load_initial_datasets()

# Run initial match on default incident
if incidents_db:
    try:
        dispatch_engine.dispatch_incident(incidents_db[0])
    except Exception as e:
        print(f"Initial incident dispatch notice: {e}")

class RakshakLiveHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        '': 'application/octet-stream',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.webmanifest': 'application/manifest+json; charset=utf-8',
    }

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS, PUT, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, data, status_code=200):
        if isinstance(data, (bytes, bytearray)):
            body = data
        else:
            body = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def translate_path(self, path):
        # Strip query strings and hash fragments
        path = path.split('?', 1)[0].split('#', 1)[0]
        path = os.path.normpath(path)
        parts = [p for p in path.split(os.sep) if p and p != '.']
        # Handle legacy path aliases like /backend/frontend/... or /frontend/...
        if len(parts) >= 2 and parts[0] == 'backend' and parts[1] == 'frontend':
            parts = parts[2:]
        elif len(parts) >= 1 and parts[0] in ('frontend', 'backend'):
            parts = parts[1:]
        
        rel_path = os.path.join(*parts) if parts else ''
        
        # Root '/' defaults to Command Center Control Room
        if not rel_path or rel_path in ('/', 'control-room.html', 'control-room', 'control', 'controlroom', 'command', 'dashboard'):
            return os.path.join(CURRENT_DIR, 'control-room-redesign.html')
        
        # Friendly aliases for citizen app
        if rel_path.lower() in ('app', 'sos-app.html', 'sos', 'bystander', 'citizen', 'citizen.html'):
            return os.path.join(CURRENT_DIR, 'index.html')

        full_path = os.path.join(CURRENT_DIR, rel_path)

        if os.path.isdir(full_path):
            cr_file = os.path.join(full_path, 'control-room-redesign.html')
            if os.path.exists(cr_file):
                return cr_file
            index_file = os.path.join(full_path, 'index.html')
            if os.path.exists(index_file):
                return index_file
        return full_path

    def do_GET(self):

        parsed = urlparse(self.path)
        path = parsed.path

        # 1. Server-Sent Events (SSE) Live Stream Endpoint
        if path == '/api/events' or path == '/events' or path == '/api/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()
            
            init_msg = f"event: ready\ndata: {json.dumps({'status': 'connected', 'serverTime': time.time()})}\n\n".encode('utf-8')
            self.wfile.write(init_msg)
            self.wfile.flush()
            
            client_queue = queue.Queue(maxsize=100)
            with sse_lock:
                sse_client_queues.append(client_queue)
            
            try:
                while True:
                    try:
                        msg = client_queue.get(timeout=15)
                        self.wfile.write(msg)
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except Exception:
                pass
            finally:
                with sse_lock:
                    if client_queue in sse_client_queues:
                        sse_client_queues.remove(client_queue)
            return

        # 2. Heartbeat & Resource Aggregates (/api/status, /api/resources/status)
        if path == '/fsws' or path == '/api/status':
            res_status = resource_manager.get_aggregate_resource_status(hospitals_db, responders_db)
            return self.send_json({
                "status": "online",
                "service": "Rakshak 112 Dynamic Dispatch Engine & Control Room Bridge",
                "active_incidents": len(incidents_db),
                "resources": res_status,
                "timestamp": time.time()
            })

        if path == '/api/resources/status':
            res_status = resource_manager.get_aggregate_resource_status(hospitals_db, responders_db)
            return self.send_json(res_status)

        # 3. Incident Specific Endpoints
        if path.startswith('/api/incidents/'):
            parts = path.strip('/').split('/')
            if len(parts) >= 3:
                inc_id = parts[2]
                sub_route = parts[3] if len(parts) >= 4 else None
                
                if sub_route == 'live':
                    snapshot = dispatch_engine.orchestrator.get_citizen_privacy_snapshot(inc_id)
                    if snapshot:
                        return self.send_json(snapshot)
                    return self.send_json({"error": "INCIDENT_NOT_FOUND"}, 404)

                if sub_route == 'timeline':
                    target = next((i for i in incidents_db if i.get('id') == inc_id), None)
                    if target:
                        timeline = target.get('timeline') or target.get('transmissionTimeline') or []
                        return self.send_json({"incidentId": inc_id, "timeline": timeline})
                    return self.send_json({"error": "INCIDENT_NOT_FOUND"}, 404)

                if sub_route == 'dispatch':
                    target = next((i for i in incidents_db if i.get('id') == inc_id), None)
                    if target:
                        return self.send_json({
                            "incidentId": inc_id,
                            "dispatchPlanId": target.get("dispatchPlanId"),
                            "assignedAmbulance": target.get("assignedAmbulance"),
                            "ambulanceDetails": target.get("assignedAmbulanceDetails"),
                            "destinationHospital": target.get("destinationHospital"),
                            "hospitalDetails": target.get("destinationDetails"),
                            "ttacMinutes": target.get("ttac_minutes") or target.get("ttacMinutes"),
                            "ttacBreakdown": target.get("ttacBreakdown"),
                            "planStatus": target.get("planStatus", "ACTIVE")
                        })
                    return self.send_json({"error": "INCIDENT_NOT_FOUND"}, 404)

                if sub_route in ('decision-log', 'decisions'):
                    logs = dispatch_engine.get_decision_log(inc_id)
                    return self.send_json({
                        "incidentId": inc_id,
                        "decisions": logs
                    })

                # GET /api/incidents/:id (Authoritative Snapshot)
                auth_snap = dispatch_engine.orchestrator.get_authoritative_snapshot(inc_id)
                if auth_snap:
                    return self.send_json(auth_snap)
                return self.send_json({"error": "INCIDENT_NOT_FOUND"}, 404)

        # 3b. GET /api/incidents (List all)
        if path == '/api/incidents' or path == '/api/sos':
            return self.send_json(incidents_db)

        # 5. GET /api/hospitals
        if path == '/api/hospitals' or path.lower() in ('/raipur_hospital.json', '/raipur_hospitals.json', '/raipur%20hospital.json', '/durg_hospital.json', '/durg_hospitals.json', '/durg%20hospital.json'):
            if hospitals_db:
                payload = {
                    "dataset_name": "Rakshak 112 Unified Hospital Intelligence Database (Raipur + Durg-Bhilai)",
                    "summary_metrics": {
                        "total_hospitals": len(hospitals_db),
                        "raipur_hospitals": sum(1 for h in hospitals_db if h.get('district') == 'Raipur'),
                        "durg_hospitals": sum(1 for h in hospitals_db if h.get('district') == 'Durg'),
                        "level_1_trauma_centres": sum(1 for h in hospitals_db if h.get('capabilities', {}).get('trauma_level') == 1),
                        "total_icu_beds_available": sum(resource_manager.get_hospital_capacity(h)["available_icu"] for h in hospitals_db),
                        "total_emergency_beds_available": sum(resource_manager.get_hospital_capacity(h)["available_er"] for h in hospitals_db)
                    },
                    "hospitals": hospitals_db
                }
                return self.send_json(payload)

        # 6. GET /api/responders
        if path == '/api/responders' or path.lower() in ('/durg_drivers.json', '/durg_responders.json', '/durg_responders_fleet_database.json', '/raipur_responders.json', '/raipur_responders_fleet_database.json'):
            if responders_db:
                payload = {
                    "dataset_name": "Rakshak 112 Unified Responders & Fleet Database (Raipur + Durg-Bhilai)",
                    "summary_metrics": {
                        "total_fleet_units": len(responders_db),
                        "available_units": sum(1 for r in responders_db if resource_manager.is_ambulance_available(r)),
                        "en_route_units": sum(1 for r in responders_db if r.get('status') == 'EN_ROUTE_TO_INCIDENT'),
                        "on_scene_units": sum(1 for r in responders_db if r.get('status') == 'ON_SCENE'),
                        "offline_units": sum(1 for r in responders_db if r.get('status') in ('MAINTENANCE', 'OFF_DUTY'))
                    },
                    "responders": responders_db
                }
                return self.send_json(payload)

        # Default static file serving
        return super().do_GET()

    def do_PATCH(self):
        return self._handle_incident_update()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
        try:
            body = json.loads(post_data.decode('utf-8'))
        except Exception:
            body = {}

        if '/status' in path:
            return self._handle_incident_update()

        # 1. POST /api/sos (Bystander App triggers SOS Beacon -> Dynamic Auto-Dispatch)
        if path == '/api/sos' or path == '/api/incidents' or path == '/api/incidents/sos':
            inc_id = body.get('id') or body.get('incidentId') or f"R112-{int(time.time() % 1000 + 100):03d}"
            lat = body.get('latitude') or body.get('lat') or 21.2065
            lng = body.get('longitude') or body.get('lng') or 81.3320
            now_ms = int(time.time() * 1000)
            client_ts = body.get('timestamp') or now_ms
            stage = body.get('stage') or 'INITIAL_BEACON'
            has_triage = bool(body.get('triage'))
            has_profile = bool(body.get('caller', {}).get('hasEmergencyIdentity'))

            comm_state = 'SYNCHRONIZED' if has_triage else 'PARTIAL'

            existing_idx = next((i for i, v in enumerate(incidents_db) if v['id'] == inc_id), None)
            
            if existing_idx is not None:
                # Idempotent retry / Progressive stage update
                target_inc = incidents_db[existing_idx]
                
                # Update location if newer
                if lat and lng and client_ts >= target_inc.get('timestamp', 0):
                    target_inc['location'] = {
                        "latitude": lat,
                        "longitude": lng,
                        "accuracy": body.get('accuracy', target_inc.get('accuracy', 12)),
                        "address": body.get('address') or target_inc.get('location', {}).get('address', 'Live GPS Beacon')
                    }
                    target_inc['lat'] = lat
                    target_inc['lng'] = lng
                    target_inc['timestamp'] = client_ts

                if body.get('emergencyType'):
                    target_inc['emergencyType'] = body.get('emergencyType')
                    target_inc['type'] = body.get('emergencyType')
                if body.get('stage'):
                    target_inc['stage'] = body.get('stage')
                if body.get('triage'):
                    target_inc['triage'] = { **target_inc.get('triage', {}), **body.get('triage', {}) }
                if body.get('caller'):
                    target_inc['caller'] = { **target_inc.get('caller', {}), **body.get('caller', {}) }
                
                target_inc['commState'] = 'SYNCHRONIZED'
                timeline = target_inc.setdefault('transmissionTimeline', [])
                timeline.append({
                    "time": now_ms,
                    "event": f"Client retry / Stage update received ({stage}) · Server ACK returned"
                })

                broadcast_sse('incident', target_inc)
                broadcast_sse('incident.updated', target_inc)

                print(f"[POST /api/sos] Idempotent ACK for existing {inc_id} (Stage: {stage})")

                return self.send_json({
                    "success": True,
                    "ack": True,
                    "incidentId": inc_id,
                    "isDuplicate": True,
                    "status": target_inc.get('status', 'RPT'),
                    "serverTime": now_ms,
                    "commState": target_inc.get('commState', 'SYNCHRONIZED'),
                    "incident": target_inc
                })

            else:
                # First-time incident creation
                new_incident = {
                    "id": inc_id,
                    "incidentId": inc_id,
                    "emergencyType": body.get('emergencyType') or body.get('type') or 'Emergency SOS (Polytrauma)',
                    "type": body.get('emergencyType') or body.get('type') or 'Emergency SOS (Polytrauma)',
                    "priority": body.get('priority') or { "code": "L1", "label": "CRITICAL", "score": 99 },
                    "location": {
                        "latitude": lat,
                        "longitude": lng,
                        "accuracy": body.get('accuracy', 12),
                        "address": body.get('address') or 'Live GPS Beacon (Bystander Mobile Link)'
                    },
                    "lat": lat,
                    "lng": lng,
                    "accuracy": body.get('accuracy', 12),
                    "status": body.get('status', 'RPT'),
                    "state": body.get('state', 'REPORTED'),
                    "stage": stage,
                    "commState": comm_state,
                    "commStages": {
                        "criticalPacket": True,
                        "triage": has_triage,
                        "profile": has_profile
                    },
                    "source": body.get('source', 'Rakshak-112 PWA (Resilient Outbox)'),
                    "timestamp": client_ts,
                    "serverReceivedAt": now_ms,
                    "triage": body.get('triage') or { "injuredCount": 1, "consciousness": "Pending Assessment" },
                    "caller": body.get('caller') or {},
                    "responseNote": body.get('notes') or body.get('responseNote') or "Initial SOS beacon triggered from Bystander mobile app. GPS lock acquired.",
                    "transmissionTimeline": [
                        { "time": client_ts, "event": "SOS captured locally in Citizen device outbox" },
                        { "time": now_ms, "event": f"✓ Initial critical packet received ({inc_id}) · Server ACK returned" }
                    ]
                }

                incidents_db.insert(0, new_incident)
                target_inc = new_incident

                # Automatically run Coordinated Dispatch Engine
                dispatch_res = dispatch_engine.dispatch_incident(target_inc)
                
                # Broadcast to Control Room & Bystander via SSE
                broadcast_sse('incident', target_inc)
                broadcast_sse('incident.created', target_inc)
                broadcast_sse('new_sos', target_inc)

                print(f"[POST /api/sos] Live Coordinated Dispatch for {inc_id}: Unit={target_inc.get('assignedAmbulance')} -> Hosp={target_inc.get('destinationHospital')} (TTAC: {target_inc.get('ttac_minutes')}m)")

                return self.send_json({
                    "success": True,
                    "ack": True,
                    "incidentId": inc_id,
                    "isDuplicate": False,
                    "status": target_inc.get('status', 'RPT'),
                    "serverTime": now_ms,
                    "commState": target_inc.get('commState', 'SYNCHRONIZED'),
                    "incident": target_inc,
                    "dispatch": dispatch_res
                })

        # 1b. POST /api/incidents/:id/telemetry (GPS Store-and-Forward Stream)
        if '/telemetry' in path:
            parts = path.strip('/').split('/')
            inc_id = parts[2] if len(parts) >= 3 else body.get('incidentId')
            target = next((v for v in incidents_db if v['id'] == inc_id), None)
            if target:
                pts = body.get('points') or [body]
                for pt in pts:
                    p_lat = pt.get('latitude') or pt.get('lat')
                    p_lng = pt.get('longitude') or pt.get('lng')
                    p_ts = pt.get('timestamp') or int(time.time() * 1000)
                    if p_lat and p_lng and p_ts >= target.get('timestamp', 0):
                        target['lat'] = p_lat
                        target['lng'] = p_lng
                        target['location']['latitude'] = p_lat
                        target['location']['longitude'] = p_lng
                        target['timestamp'] = p_ts
                
                broadcast_sse('incident.updated', target)
                return self.send_json({ "success": True, "ack": True, "incidentId": inc_id, "pointsProcessed": len(pts) })
            return self.send_json({ "error": "Incident not found" }, status=404)

        # 1c. POST /api/incidents/:id/assessment (Rapid 5-Question Victim Assessment)
        if '/assessment' in path:
            parts = path.strip('/').split('/')
            inc_id = parts[2] if len(parts) >= 3 else body.get('incidentId')
            target = next((v for v in incidents_db if v['id'] == inc_id), None)
            if target:
                assessment_data = body.get('assessment') or body
                target['assessment'] = {
                    "conscious": assessment_data.get('conscious', 'YES'),
                    "breathing": assessment_data.get('breathing', 'NORMAL'),
                    "heavyBleeding": bool(assessment_data.get('heavyBleeding')),
                    "severePain": bool(assessment_data.get('severePain')),
                    "movement": assessment_data.get('movement', 'NORMAL'),
                    "completedAt": assessment_data.get('completedAt') or int(time.time() * 1000),
                    "completed": True,
                    "summary": assessment_data.get('summary', '')
                }
                # Update triage indicators
                target_triage = target.setdefault('triage', {})
                if target['assessment']['heavyBleeding']:
                    target_triage['severeBleeding'] = True
                if target['assessment']['conscious'] in ('NO', 'NOT_SURE'):
                    target_triage['consciousness'] = 'Unresponsive / Confused'
                elif target['assessment']['conscious'] == 'YES':
                    target_triage['consciousness'] = 'Alert & Responsive'
                if target['assessment']['breathing'] == 'SEVERE':
                    target_triage['breathing'] = 'Severe Difficulty'
                elif target['assessment']['breathing'] == 'MILD':
                    target_triage['breathing'] = 'Mild Difficulty'

                # If critical answers, escalate priority
                is_crit = (target['assessment']['heavyBleeding'] or 
                           target['assessment']['breathing'] == 'SEVERE' or 
                           target['assessment']['conscious'] == 'NO')
                if is_crit:
                    target['priority'] = { "code": "L1", "label": "CRITICAL", "score": 100 }

                # Reevaluate dispatch plan with new assessment data
                dispatch_engine.reevaluate_incident(inc_id, trigger_reason="RAPID_ASSESSMENT_COMPLETED")
                broadcast_sse('incident.updated', target)
                broadcast_sse('incident:assessment', { "incidentId": inc_id, "assessment": target['assessment'], "incident": target })
                return self.send_json({ "success": True, "ack": True, "incidentId": inc_id, "assessment": target['assessment'], "incident": target })
            return self.send_json({ "error": "Incident not found" }, 404)

        # 2. POST /api/incidents/:id/auto-match (Manual or Auto trigger for optimal TTAC)
        if 'auto-match' in path:
            parts = path.strip('/').split('/')
            inc_id = parts[2] if len(parts) >= 3 else (incidents_db[0]['id'] if incidents_db else None)
            target = next((v for v in incidents_db if v['id'] == inc_id), None)
            if target:
                match_res = dispatch_engine.dispatch_incident(target)
                broadcast_sse('dispatch:reoptimized', { "incident": target, "result": match_res })
                return self.send_json({ "success": True, "result": match_res, "incident": target })
            return self.send_json({ "success": False, "error": "INCIDENT_NOT_FOUND" }, 404)

        # 3. POST /api/incidents/:id/reevaluate
        if 'reevaluate' in path:
            parts = path.strip('/').split('/')
            inc_id = parts[2] if len(parts) >= 3 else None
            res = dispatch_engine.reevaluate_incident(inc_id, trigger_reason=body.get("reason", "DISPATCHER_TRIGGERED"))
            return self.send_json(res)

        # 4. POST /api/hospitals/:id/ack (Hospital pre-alert acknowledgement or rejection)
        if '/ack' in path:
            parts = path.strip('/').split('/')
            hosp_id = parts[2] if len(parts) >= 3 else body.get('hospital_id')
            inc_id = body.get('incident_id') or (incidents_db[0]['id'] if incidents_db else None)
            accepted = body.get('accepted', True)
            reason = body.get('reason', '')
            res = dispatch_engine.handle_hospital_ack(inc_id, hosp_id, accepted, reason)
            return self.send_json(res)

        # 5. POST /api/responders/:id/location (Live GPS update with anomaly detection)
        if '/location' in path:
            parts = path.strip('/').split('/')
            resp_id = parts[2] if len(parts) >= 3 else body.get('unit_id')
            lat = float(body.get('latitude') or body.get('lat') or 0.0)
            lng = float(body.get('longitude') or body.get('lng') or 0.0)
            speed = float(body.get('speed_kmh') or body.get('speed') or 0.0)
            res = dispatch_engine.update_responder_telemetry(resp_id, lat, lng, speed)
            return self.send_json(res)

        # 5b. POST /api/responders/:id/status (e.g. AT_SCENE, PATIENT_ON_BOARD, AT_HOSPITAL, BREAKDOWN)
        if '/status' in path and path.startswith('/api/responders/'):
            parts = path.strip('/').split('/')
            resp_id = parts[2] if len(parts) >= 3 else body.get('unit_id')
            new_status = body.get('status') or body.get('operational_status') or 'EN_ROUTE'
            inc_id = body.get('incidentId') or body.get('incident_id')
            res = dispatch_engine.orchestrator.update_responder_status(resp_id, new_status, incident_id=inc_id)
            return self.send_json(res)

        # 5c. POST /api/incidents/:id/override (Dispatcher Manual Override)
        if 'override' in path:
            parts = path.strip('/').split('/')
            inc_id = parts[2] if len(parts) >= 3 else body.get('incidentId')
            amb_id = body.get('ambulanceId') or body.get('ambulance_id')
            hosp_id = body.get('hospitalId') or body.get('hospital_id')
            disp_name = body.get('dispatcherName') or body.get('dispatcher') or 'Dispatcher'
            reason = body.get('reason') or 'Manual operational discretion'
            res = dispatch_engine.orchestrator.apply_dispatcher_override(
                incident_id=inc_id,
                ambulance_id=amb_id,
                hospital_id=hosp_id,
                dispatcher_name=disp_name,
                reason=reason
            )
            return self.send_json(res)

        # 5d. POST /api/incidents/:id/escalate
        if 'escalate' in path:
            parts = path.strip('/').split('/')
            inc_id = parts[2] if len(parts) >= 3 else body.get('incidentId')
            target = next((v for v in incidents_db if v['id'] == inc_id), None)
            if target:
                reason = body.get('reason') or 'MANUAL_DISPATCHER_ESCALATION'
                desc = body.get('description') or 'Incident escalated for supervisory review'
                from services.orchestrator import escalation_manager
                esc = escalation_manager.trigger_escalation(target, reason, desc)
                broadcast_sse('incident:escalated', target)
                return self.send_json({"success": True, "escalation": esc, "incident": target})
            return self.send_json({"error": "INCIDENT_NOT_FOUND"}, 404)

        # 6. POST /api/incidents/:id/assign-destination
        if 'assign-destination' in path:
            parts = path.strip('/').split('/')
            inc_id = parts[2] if len(parts) >= 3 else None
            target = next((v for v in incidents_db if v['id'] == inc_id), None)
            hosp_id = body.get('hospitalId') or body.get('hospital_id')
            hosp_obj = next((h for h in hospitals_db if h.get('id') == hosp_id), None)
            
            if target and hosp_obj:
                # Delegate to orchestrator override
                res = dispatch_engine.orchestrator.apply_dispatcher_override(
                    incident_id=inc_id,
                    hospital_id=hosp_id,
                    reason=body.get('reason', 'Hospital manually assigned from Intel panel')
                )
                return self.send_json(res)
            return self.send_json({"ok": False, "error": "TARGET_OR_HOSPITAL_NOT_FOUND"}, 400)

        # 7. POST /api/dispatch (Direct Dispatch event)
        if path == '/api/dispatch' or path == '/api/responders/dispatch':
            broadcast_sse('dispatch', body)
            broadcast_sse('incident:update', body)
            return self.send_json({"success": True, "status": "dispatched", "data": body})

        # Fallback 200 for other POSTs
        return self.send_json({"success": True, "status": "ok", "path": path})

    def _handle_incident_update(self):
        parsed = urlparse(self.path)
        path = parsed.path

        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
        try:
            body = json.loads(post_data.decode('utf-8'))
        except Exception:
            body = {}

        parts = path.strip('/').split('/')
        inc_id = parts[2] if len(parts) >= 3 else (incidents_db[0]['id'] if incidents_db else 'INC-204')

        target = None
        for inc in incidents_db:
            if inc['id'] == inc_id:
                target = inc
                break
        
        if not target:
            target = {
                "id": inc_id,
                "status": body.get('status', 'TRI'),
                "emergencyType": body.get('emergencyType', 'Emergency SOS'),
                "type": body.get('emergencyType', 'Emergency SOS'),
                "priority": body.get('priorityOverride') or { "code": "L1", "label": "CRITICAL", "score": 99 },
                "location": { "latitude": 21.2065, "longitude": 81.3320, "address": "Live GPS Beacon" },
                "lat": 21.2065,
                "lng": 81.3320,
                "timestamp": int(time.time() * 1000),
                "triage": body.get('triage', {}),
                "caller": {}
            }
            incidents_db.insert(0, target)

        for k, v in body.items():
            if k == 'priorityOverride':
                target['priority'] = v
            elif k == 'note' and 'responseNote' not in body:
                target['responseNote'] = v
            else:
                target[k] = v

        if 'emergencyType' in body:
            target['type'] = body['emergencyType']

        if 'assessment' in body:
            ass_data = body['assessment']
            target['assessment'] = {
                "conscious": ass_data.get('conscious', 'YES'),
                "breathing": ass_data.get('breathing', 'NORMAL'),
                "heavyBleeding": bool(ass_data.get('heavyBleeding')),
                "severePain": bool(ass_data.get('severePain')),
                "movement": ass_data.get('movement', 'NORMAL'),
                "completedAt": ass_data.get('completedAt') or int(time.time() * 1000),
                "completed": True,
                "summary": ass_data.get('summary', '')
            }
            target_triage = target.setdefault('triage', {})
            if target['assessment']['heavyBleeding']:
                target_triage['severeBleeding'] = True
            if target['assessment']['conscious'] in ('NO', 'NOT_SURE'):
                target_triage['consciousness'] = 'Unresponsive / Confused'
            elif target['assessment']['conscious'] == 'YES':
                target_triage['consciousness'] = 'Alert & Responsive'
            if target['assessment']['breathing'] == 'SEVERE':
                target_triage['breathing'] = 'Severe Difficulty'
            elif target['assessment']['breathing'] == 'MILD':
                target_triage['breathing'] = 'Mild Difficulty'

            if target['assessment']['heavyBleeding'] or target['assessment']['breathing'] == 'SEVERE' or target['assessment']['conscious'] == 'NO':
                target['priority'] = { "code": "L1", "label": "CRITICAL", "score": 100 }

        # If priority, assessment or triage changed, trigger dynamic re-evaluation
        if 'priorityOverride' in body or 'triage' in body or 'assessment' in body:
            dispatch_engine.reevaluate_incident(inc_id, trigger_reason="TRIAGE_UPDATED")

        status_val = target.get('status', '')
        if status_val == 'CANCELLED':
            resource_manager.release_incident_reservations(inc_id)
            broadcast_sse('incident.cancelled', target)
        elif status_val in ('CLS', 'RESOLVED'):
            resource_manager.release_incident_reservations(inc_id)
            broadcast_sse('incident.resolved', target)
        
        broadcast_sse('incident:update', target)
        broadcast_sse('incident', target)
        broadcast_sse('incident.updated', target)

        print(f"[PATCH status] Incident {inc_id} updated: {target.get('status')} / {target.get('stage')} / {target.get('emergencyType')}")

        return self.send_json({
            "success": True,
            "incident": target
        })

def find_available_port():
    if os.environ.get('PORT'):
        try:
            return int(os.environ.get('PORT'))
        except (ValueError, TypeError):
            pass
    for p in [8000, 8081, 8082, 5500, 5501, 8088, 3000]:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('0.0.0.0', p))
                return p
        except Exception:
            continue
    return 8000

def start_server(port):
    os.chdir(ROOT_DIR)
    
    host = os.environ.get('HOST', '0.0.0.0')
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((host, port), RakshakLiveHandler)
    print(f"===============================================================================")
    print(f"   RAKSHAK 112 DYNAMIC CONSTRAINT-AWARE EMERGENCY DISPATCH BACKEND ONLINE")
    print(f"===============================================================================")
    print(f" Serving Directory: {ROOT_DIR}")
    print(f" Host / Port:       http://{host}:{port}/")
    print(f" SSE Stream:        http://{host}:{port}/api/events")
    print(f" Auto-Match API:    http://{host}:{port}/api/incidents/:id/auto-match")
    print(f" Resource Status:   http://{host}:{port}/api/resources/status")
    print(f"")
    print(f" [TAB 1] Bystander / Citizen SOS App: http://localhost:{port}/index.html")
    print(f" [TAB 2] Command Center Control Room: http://localhost:{port}/control-room-redesign.html")
    print(f"===============================================================================")
    print(f" Press Ctrl+C to stop the server.\n")

    # In cloud environments (Render, Linux containers, or --no-browser), skip opening browser tabs
    is_headless = bool(
        '--no-browser' in sys.argv or 
        os.environ.get('RENDER') or 
        os.environ.get('PORT') or 
        not sys.platform.startswith('win')
    )

    if not is_headless:
        def open_tabs():
            time.sleep(0.4)
            ts = int(time.time())
            webbrowser.open(f"http://localhost:{port}/index.html?t={ts}")
            time.sleep(0.3)
            webbrowser.open(f"http://localhost:{port}/control-room-redesign.html?t={ts}")

        threading.Thread(target=open_tabs, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Rakshak 112 backend...")
        server.server_close()

if __name__ == '__main__':
    port = find_available_port()
    start_server(port)
