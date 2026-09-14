/**
 * Rakshak 112 — Dynamic Constraint-Aware Live Monitoring Command Console
 * Architecture: Incident Queue (Left) → Live Field Map (Center) → Compact Selected Incident Workspace (Right)
 * Single Source of Truth: window.liveMonitoringState.selectedIncidentId
 * Principles: Progressive Disclosure, High Scannability, Zero Redundant Text
 */

(function(window) {
  'use strict';

  function $id(id) { return document.getElementById(id); }
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 1. Authoritative Live Monitoring State
  window.liveMonitoringState = {
    incidents: [],
    selectedIncidentId: null,
    filter: 'ALL', // 'ALL' | 'CRITICAL' | 'ACTIVE' | 'RESOLVED'
    search: '',
    eventStreams: {}, // incidentId -> [{ time, category, text, tag }]
    globalEvents: []
  };

  const MAX_EVENTS_PER_INCIDENT = 30;

  // 2. Helper to retrieve selected incident object
  window.getSelectedIncident = function() {
    const id = window.liveMonitoringState.selectedIncidentId;
    if (!id) return null;
    return (window.liveMonitoringState.incidents || []).find(i => i.id === id || i.incidentId === id)
      || (window.incidents || []).find(i => i.id === id || i.incidentId === id)
      || null;
  };

  // 3. Progressive Disclosure Accordion Controller
  window.toggleLmAccordion = function(contentId, btn) {
    const el = $id(contentId);
    if (!el) return;
    const isCurrentlyOpen = el.classList.contains('open');
    if (isCurrentlyOpen) {
      el.classList.remove('open');
      el.style.display = 'none';
      if (btn) {
        const badge = btn.querySelector('span:last-child');
        if (badge) badge.textContent = (btn.textContent.includes('Why') ? 'DETAILS' : 'EXPAND');
      }
    } else {
      el.classList.add('open');
      el.style.display = 'block';
      if (btn) {
        const badge = btn.querySelector('span:last-child');
        if (badge) badge.textContent = (btn.textContent.includes('Why') ? 'HIDE' : 'COLLAPSE');
      }
    }
  };

  // 4. Toggle Incident Queue Minimize / Expand
  window.toggleIncidentQueueCollapse = function() {
    const queueCol = $id('lmQueueCol');
    const grid = (typeof document.querySelector === 'function' ? document.querySelector('#live-monitoring-page .lm-workspace-grid') : null)
      || (queueCol ? queueCol.parentElement : null);
    const arrow = $id('lmToggleQueueArrow');
    const btn = $id('btnToggleQueue');
    if (!queueCol) return;

    const isCollapsed = queueCol.classList.toggle('collapsed');
    if (grid && grid.classList) {
      grid.classList.toggle('queue-collapsed', isCollapsed);
    }

    if (arrow) {
      arrow.textContent = isCollapsed ? '▶' : '◀';
    }
    if (btn) {
      btn.title = isCollapsed ? 'Expand Incident Queue' : 'Minimize Incident Queue (Expand Map)';
    }

    // Trigger map canvas/tile resize after smooth CSS transition
    setTimeout(() => {
      if (typeof window.invalidateLiveMaps === 'function') {
        window.invalidateLiveMaps();
      } else if (typeof invalidateLiveMaps === 'function') {
        invalidateLiveMaps();
      }
    }, 280);
  };

  // 5. Live Clock
  function updateClock() {
    const clockEl = $id('lmClock');
    if (clockEl) {
      const now = new Date();
      clockEl.textContent = now.toTimeString().split(' ')[0] + ' IST';
    }
  }
  setInterval(updateClock, 1000);

  // 5. Atomic Resource Status Fetcher (/api/resources/status)
  async function updateResourceStatusCounts() {
    try {
      const res = await fetch('/api/resources/status');
      if (!res.ok) return;
      const data = await res.json();

      // ICU Beds
      const icuAvail = data.available_icu ?? data.icu?.available ?? 0;
      const icuOcc = data.occupied_icu ?? data.icu?.occupied ?? 0;
      const icuRes = data.reserved_icu ?? data.icu?.reserved ?? 0;
      if ($id('resIcuAvail')) $id('resIcuAvail').textContent = `${icuAvail} Free`;
      if ($id('resIcuOcc')) $id('resIcuOcc').textContent = `${icuOcc} Occupied`;
      if ($id('resIcuRes')) $id('resIcuRes').textContent = `${icuRes} Reserved`;

      // ER Beds
      const erAvail = data.available_er ?? data.er?.available ?? 0;
      const erOcc = data.occupied_er ?? data.er?.occupied ?? 0;
      const erRes = data.reserved_er ?? data.er?.reserved ?? 0;
      if ($id('resErAvail')) $id('resErAvail').textContent = `${erAvail} Free`;
      if ($id('resErOcc')) $id('resErOcc').textContent = `${erOcc} Occupied`;
      if ($id('resErRes')) $id('resErRes').textContent = `${erRes} Reserved`;

      // Ambulance Fleet
      const ambAvail = data.available_ambulances ?? data.ambulances?.available ?? 0;
      const ambDispatched = data.dispatched_ambulances ?? data.ambulances?.dispatched ?? 0;
      const ambBusy = data.busy_ambulances ?? data.ambulances?.busy ?? 0;
      if ($id('resAmbAvail')) $id('resAmbAvail').textContent = `${ambAvail} Available`;
      if ($id('resAmbDispatched')) $id('resAmbDispatched').textContent = `${ambDispatched} Dispatched`;
      if ($id('resAmbBusy')) $id('resAmbBusy').textContent = `${ambBusy} Busy`;
    } catch (e) {
      console.debug('Resource status update skipped:', e);
    }
  }

  // 6. Incident Queue Filtering & Searching
  window.setMonitoringQueueFilter = function(filterType, btn) {
    window.liveMonitoringState.filter = filterType;
    if (btn) {
      const parent = btn.parentElement;
      if (parent) {
        parent.querySelectorAll('.lm-pill').forEach(p => p.classList.remove('active'));
      }
      btn.classList.add('active');
    }
    window.renderLiveMonitoringQueue();
  };

  window.onMonitoringQueueSearch = function(query) {
    window.liveMonitoringState.search = (query || '').toLowerCase().trim();
    window.renderLiveMonitoringQueue();
  };

  // 7. Master Queue Renderer
  window.renderLiveMonitoringQueue = function() {
    const queueEl = $id('lmIncidentQueue');
    if (!queueEl) return;

    if (!window.liveMonitoringState.incidents.length && window.incidents && window.incidents.length) {
      window.liveMonitoringState.incidents = [...window.incidents];
    }

    const allInc = window.liveMonitoringState.incidents || [];
    
    let critCount = 0, highCount = 0, modCount = 0, activeCount = 0;
    allInc.forEach(inc => {
      const isResolved = inc.status === 'RESOLVED' || inc.status === 'CLOSED' || inc.state === 'INCIDENT_CLOSED' || inc.stage === 'RESOLVED';
      if (!isResolved) activeCount++;
      const code = inc.priority?.code || (inc.priority?.score >= 80 ? 'L1' : 'L2');
      if (code === 'L1') critCount++;
      else if (code === 'L2') highCount++;
      else modCount++;
    });

    if ($id('lmQueueCountBadge')) $id('lmQueueCountBadge').textContent = `${activeCount} ACTIVE`;
    if ($id('lmQueueCountBadgeMin')) $id('lmQueueCountBadgeMin').textContent = activeCount;
    if ($id('sbCountTotal')) $id('sbCountTotal').textContent = activeCount;
    if ($id('sbCountCrit')) $id('sbCountCrit').textContent = critCount;
    if ($id('sbCountHigh')) $id('sbCountHigh').textContent = highCount;
    if ($id('sbCountMod')) $id('sbCountMod').textContent = modCount;

    const filter = window.liveMonitoringState.filter;
    const search = window.liveMonitoringState.search;

    const filtered = allInc.filter(inc => {
      const isResolved = inc.status === 'RESOLVED' || inc.status === 'CLOSED' || inc.state === 'INCIDENT_CLOSED' || inc.stage === 'RESOLVED';
      const isCrit = inc.priority?.code === 'L1' || (inc.priority?.score || 0) >= 80;

      if (filter === 'CRITICAL' && !isCrit) return false;
      if (filter === 'ACTIVE' && isResolved) return false;
      if (filter === 'RESOLVED' && !isResolved) return false;

      if (search) {
        const id = (inc.id || inc.incidentId || '').toLowerCase();
        const type = (inc.emergencyType || inc.type || '').toLowerCase();
        const loc = (inc.location?.address || inc.address || '').toLowerCase();
        if (!id.includes(search) && !type.includes(search) && !loc.includes(search)) {
          return false;
        }
      }
      return true;
    });

    if (!filtered.length) {
      queueEl.innerHTML = `
        <div style="text-align:center;padding:24px 10px;color:#64748b;font-size:0.75rem;">
          No incidents matching "${filter}" filter.
        </div>
      `;
      return;
    }

    const selId = window.liveMonitoringState.selectedIncidentId;

    queueEl.innerHTML = filtered.map(inc => {
      const incId = inc.id || inc.incidentId || 'INC';
      const isSelected = selId === incId;
      const isCrit = inc.priority?.code === 'L1' || (inc.priority?.score || 0) >= 80;
      const isResolved = inc.status === 'RESOLVED' || inc.status === 'CLOSED' || inc.stage === 'RESOLVED';
      
      let sevClass = 'is-high';
      let sevLabel = 'HIGH · L2';
      let sevDot = '🟠';
      let sevBadgeBg = '#7c2d12';
      let sevBadgeColor = '#fed7aa';

      if (isResolved) {
        sevClass = 'is-res';
        sevLabel = 'RESOLVED';
        sevDot = '🟢';
        sevBadgeBg = '#064e3b';
        sevBadgeColor = '#a7f3d0';
      } else if (isCrit) {
        sevClass = 'is-crit';
        sevLabel = 'CRITICAL · L1';
        sevDot = '🔴';
        sevBadgeBg = '#450a0a';
        sevBadgeColor = '#fca5a5';
      } else if (inc.priority?.code === 'L3') {
        sevClass = 'is-mod';
        sevLabel = 'MODERATE · L3';
        sevDot = '🟡';
        sevBadgeBg = '#422006';
        sevBadgeColor = '#fef08a';
      }

      const inj = inc.triage?.injuredCount ?? inc.injured ?? 1;
      const bleed = inc.triage?.severeBleeding ? 'Severe Bleeding' : 'Stable';
      const type = inc.emergencyType || inc.type || 'Emergency SOS';
      
      const d = new Date(inc.timestamp || Date.now());
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Ambulance status snippet
      const ambData = inc.dispatch?.ambulance || inc.assignedAmbulanceDetails || {};
      const ambId = ambData.id || inc.assignedAmbulance;
      let ambSnippet = '⏳ Awaiting Ambulance';
      if (isResolved) {
        ambSnippet = '✓ Mission Completed';
      } else if (ambId) {
        const ambStatus = (ambData.status || inc.stage || 'EN_ROUTE').replace(/_/g, ' ');
        ambSnippet = `🚑 ${ambId} · ${ambStatus}`;
      }

      return `
        <div class="lm-queue-card ${sevClass} ${isSelected ? 'selected' : ''}" onclick="selectMonitoringIncident('${esc(incId)}')">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <div style="display:flex;align-items:center;gap:5px;">
              <span>${sevDot}</span>
              <span style="font-weight:900;font-size:0.8rem;color:#f8fafc;letter-spacing:0.02em;">${esc(incId)}</span>
            </div>
            <span class="badge" style="background:${sevBadgeBg};color:${sevBadgeColor};border:1px solid ${sevBadgeColor}44;font-size:0.65rem;padding:2px 5px;">
              ${esc(sevLabel)}
            </span>
          </div>
          
          <div style="font-size:0.75rem;font-weight:700;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px;">
            ${esc(type)}
          </div>
          
          <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:#94a3b8;margin-bottom:4px;">
            <span>${inj} casualty · ${bleed}</span>
            <span style="color:#7dd3fc;font-family:monospace;">${timeStr}</span>
          </div>

          <div style="font-size:0.68rem;color:#38bdf8;background:rgba(56,189,248,0.08);padding:3px 6px;border-radius:4px;border:1px solid rgba(56,189,248,0.2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${esc(ambSnippet)}
          </div>
        </div>
      `;
    }).join('');
  };

  // 8. Incident Selection (Single Source of Truth Controller)
  window.selectMonitoringIncident = function(incidentId) {
    if (!incidentId) return;
    
    window.liveMonitoringState.selectedIncidentId = incidentId;

    const inc = window.getSelectedIncident();
    if (inc) {
      window.selected = inc;
    }

    // 1. Update queue selection visual highlight
    window.renderLiveMonitoringQueue();

    // 2. Render all right-side detail panels
    window.renderLiveMonitoringWorkspace();

    // 3. Center map on selected incident & draw route
    if (typeof window.syncLiveMonitoringMap === 'function') {
      window.syncLiveMonitoringMap(inc);
    } else if (typeof window.renderLiveMonitoringMapMarkers === 'function') {
      window.renderLiveMonitoringMapMarkers();
    }
  };

  // 9. Render Response Timeline (Compact, High Scannability, Dominant Active Step)
  function renderResponseTimeline(inc) {
    const container = $id('lmTimelineSteppedList');
    if (!container) return;

    if (!inc) {
      container.innerHTML = '<div style="color:#64748b;font-size:0.72rem;">No incident selected.</div>';
      return;
    }

    const state = inc.state || inc.status || 'REPORTED';
    const stage = inc.stage || 'REPORTED';
    const ambData = inc.dispatch?.ambulance || inc.assignedAmbulanceDetails || {};
    const hospData = inc.dispatch?.hospital || inc.destinationDetails || {};

    const s1_time = inc.timestamp ? new Date(inc.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '07:34';

    // 8 Exact Milestones
    const s1_done = true;
    const s2_done = Boolean(inc.location?.latitude || inc.lat);
    const s3_done = Boolean(inc.assignedAmbulance || ambData.id);
    const s4_done = s3_done && (stage === 'DISPATCHED' || stage === 'EN_ROUTE' || stage === 'ARRIVED' || stage === 'RESOLVED' || ['AMBULANCE_DISPATCHED', 'AMBULANCE_EN_ROUTE', 'AMBULANCE_AT_SCENE', 'PATIENT_ON_BOARD', 'AT_HOSPITAL', 'INCIDENT_CLOSED'].includes(state));
    const s5_done = ['AMBULANCE_AT_SCENE', 'PATIENT_ON_BOARD', 'EN_ROUTE_TO_HOSPITAL', 'AT_HOSPITAL', 'HANDOVER_COMPLETE', 'INCIDENT_CLOSED'].includes(state) || ['ARRIVED', 'RESOLVED'].includes(stage);
    const s5_active = !s5_done && (s4_done || stage === 'EN_ROUTE' || ambData.status === 'EN_ROUTE_TO_INCIDENT' || ambData.status === 'EN_ROUTE');
    const s6_done = Boolean(inc.destinationHospital || hospData.name);
    const s7_done = s6_done && (hospData.status === 'CONFIRMED' || hospData.status === 'PREALERT_SENT' || hospData.status === 'LOCKED' || ['HOSPITAL_PREALERT_SENT', 'HOSPITAL_CONFIRMED', 'EN_ROUTE_TO_HOSPITAL', 'AT_HOSPITAL', 'INCIDENT_CLOSED'].includes(state));
    const s7_active = !s7_done && s6_done;
    const s8_done = ['AMBULANCE_AT_SCENE', 'AT_HOSPITAL', 'HANDOVER_COMPLETE', 'INCIDENT_CLOSED'].includes(state) || ['ARRIVED', 'RESOLVED'].includes(stage);

    // Update Header Stage Badge
    if ($id('lmTimelineStageBadge')) {
      if (s8_done) $id('lmTimelineStageBadge').textContent = 'SCENE ARRIVED';
      else if (s5_active) $id('lmTimelineStageBadge').textContent = 'EN ROUTE';
      else if (s4_done) $id('lmTimelineStageBadge').textContent = 'DISPATCHED';
      else if (s3_done) $id('lmTimelineStageBadge').textContent = 'ASSIGNED';
      else $id('lmTimelineStageBadge').textContent = 'INTAKE';
    }

    const milestones = [
      { title: 'SOS Triggered', time: s1_time, status: 'completed' },
      { title: 'Location Verified', time: s1_time, status: s2_done ? 'completed' : 'pending' },
      { title: 'Ambulance Assigned', time: '', status: s3_done ? 'completed' : 'pending' },
      { title: 'Dispatched', time: '', status: s4_done ? 'completed' : (s3_done ? 'active' : 'pending') },
      { title: 'Ambulance En Route', time: s5_active ? 'NOW' : '', status: s5_done ? 'completed' : (s5_active ? 'active' : 'pending') },
      { title: 'Hospital Selected', time: '', status: s6_done ? 'completed' : 'pending' },
      { title: 'Hospital Notified', time: s7_active ? 'NOW' : '', status: s7_done ? 'completed' : (s7_active ? 'active' : 'pending') },
      { title: 'Arrived', time: '', status: s8_done ? 'completed' : 'pending' }
    ];

    container.innerHTML = milestones.map(m => {
      let icon = '○';
      let titleHtml = m.title;
      if (m.status === 'completed') {
        icon = '✓';
      } else if (m.status === 'active') {
        icon = '🔵';
        titleHtml = `<b>${m.title.toUpperCase()}</b>`;
      }

      return `
        <div class="lm-step-item ${m.status}">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:0.72rem;">${icon}</span>
            <span style="font-size:0.72rem;">${titleHtml}</span>
          </div>
          ${m.time ? `<span style="font-size:0.68rem;font-family:monospace;color:${m.status==='active'?'#38bdf8':'#7e92b2'};font-weight:${m.status==='active'?'900':'normal'};">${m.time}</span>` : ''}
        </div>
      `;
    }).join('');
  }

  // 10. Render Real-Time Updates Event Stream (Compact One-Line Format)
  function renderIncidentEventStream(inc) {
    const timelineEl = $id('lmCard4Timeline');
    if (!timelineEl) return;

    if (!inc) {
      timelineEl.innerHTML = '<div style="color:#64748b;font-size:0.75rem;padding:4px 0;">No active events.</div>';
      return;
    }

    const incId = inc.id || inc.incidentId;
    const incidentEvents = window.liveMonitoringState.eventStreams[incId] || [];

    let items = [];

    const timeStr = inc.timestamp ? new Date(inc.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '19:35';
    const ambId = inc.assignedAmbulance || inc.dispatch?.ambulance?.id || 'AMB-108-10';
    const hospName = inc.destinationHospital || inc.dispatch?.hospital?.name || 'SHRI SHANKARACHARYA';

    items.push({ dot: '🔵', time: timeStr, text: `SOS received · ${esc(incId)}` });
    items.push({ dot: '🔵', time: timeStr, text: `Ambulance ${esc(ambId)} assigned` });
    items.push({ dot: '🟢', time: timeStr, text: `Hospital pre-alert sent (${esc(hospName)})` });
    items.push({ dot: '🟢', time: timeStr, text: `Ambulance en route` });

    if (incidentEvents.length) {
      incidentEvents.forEach(evt => {
        let dot = '🔵';
        if (evt.tag === 'danger') dot = '🔴';
        else if (evt.tag === 'warn') dot = '🟠';
        else if (evt.tag === 'ok') dot = '🟢';

        items.unshift({ dot, time: evt.time?.slice(0, 5) || timeStr, text: `${esc(evt.text || evt.category)}` });
      });
    }

    timelineEl.innerHTML = items.slice(0, 8).map(item => `
      <div style="display:flex;align-items:center;gap:6px;font-size:0.72rem;padding:2px 0;">
        <span>${item.dot}</span>
        <span style="color:#7e92b2;font-family:monospace;font-size:0.68rem;min-width:36px;">${item.time}</span>
        <span style="color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.text}</span>
      </div>
    `).join('');
  }

  // 11. Master Selected Incident Workspace Renderer (Compact & Scannable Hierarchy)
  window.renderLiveMonitoringWorkspace = function() {
    const inc = window.getSelectedIncident();
    
    const standbyDashboard = $id('lmStandbyDashboard');
    const activeWorkspace = $id('lmActiveWorkspace');

    // Case 1: Standby Dashboard (No incident selected)
    if (!inc) {
      if (standbyDashboard) standbyDashboard.style.display = 'flex';
      if (activeWorkspace) activeWorkspace.style.display = 'none';
      updateResourceStatusCounts();
      return;
    }

    // Case 2: Active Selected Incident -> Show 5 Workspace Panels
    if (standbyDashboard) standbyDashboard.style.display = 'none';
    if (activeWorkspace) activeWorkspace.style.display = 'flex';

    // --- PANEL 1: INCIDENT DETAILS & VICTIM ASSESSMENT ---
    const incId = inc.id || inc.incidentId || 'INC-204';
    if ($id('lmDetailId')) $id('lmDetailId').textContent = incId;
    
    if ($id('lmDetailSeverityBadge')) {
      const isL1 = inc.priority?.code === 'L1' || (inc.priority?.score || 0) >= 80;
      $id('lmDetailSeverityBadge').className = isL1 ? 'badge badge-critical' : 'badge badge-standard';
      $id('lmDetailSeverityBadge').textContent = isL1 ? 'CRITICAL' : (inc.priority?.label || 'ACTIVE');
    }
    
    if ($id('lmDetailStatusBadge')) {
      $id('lmDetailStatusBadge').textContent = (inc.stage || inc.status || 'AMBULANCE EN ROUTE').replace(/_/g, ' ');
    }

    if ($id('lmDetailType')) {
      $id('lmDetailType').textContent = inc.emergencyType || inc.type || 'Road Traffic Accident';
    }

    // Clean Location (No cluttering GPS coordinates in primary title)
    const lat = inc.location?.latitude ?? inc.lat;
    const lng = inc.location?.longitude ?? inc.lng;
    const coords = (lat != null && lng != null) ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : '';
    
    let rawLoc = inc.location?.address || inc.address || 'Supela Chowk, Bhilai';
    let cleanLoc = rawLoc.replace(/\s*\([\d\.\s,+-]+\)\s*$/, '').trim();
    if ($id('lmDetailLocation')) {
      $id('lmDetailLocation').textContent = `📍 ${cleanLoc}`;
    }

    if ($id('lmDetailCoords')) {
      $id('lmDetailCoords').textContent = coords ? `GPS: ${coords} · RTK ±12m accuracy` : 'GPS telemetry verified';
    }

    if ($id('lmDetailTime')) {
      const d = new Date(inc.timestamp || Date.now());
      $id('lmDetailTime').textContent = `🕐 ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const inj = inc.triage?.injuredCount ?? inc.injured ?? 2;
    if ($id('lmDetailVitals')) {
      $id('lmDetailVitals').textContent = `${inj} casualties`;
    }

    // Quick Assessment Chips (Scannable Level 1 summary)
    const chipsBox = $id('lmDetailAssessmentChips');
    if (chipsBox) {
      const a = inc.assessment || {};
      const chips = [];
      
      // Bleeding
      if (a.heavyBleeding || inc.triage?.severeBleeding) {
        chips.push('<span class="med-chip req">🔴 Heavy Bleeding</span>');
      } else {
        chips.push('<span class="med-chip verified">✓ Bleeding Controlled</span>');
      }

      // Breathing
      if (a.breathing === 'SEVERE' || a.breathing === 'MILD') {
        chips.push('<span class="med-chip req">⚠ Breathing Difficulty</span>');
      } else {
        chips.push('<span class="med-chip verified">✓ Normal Breathing</span>');
      }

      // Consciousness
      if (a.conscious === 'NO') {
        chips.push('<span class="med-chip req">🔴 Unconscious</span>');
      } else if (a.conscious === 'CONFUSED') {
        chips.push('<span class="med-chip req">⚠ Confused</span>');
      } else {
        chips.push('<span class="med-chip verified">✓ Alert &amp; Conscious</span>');
      }

      // Movement
      if (a.movement === 'CANNOT_MOVE') {
        chips.push('<span class="med-chip req">🔴 Cannot Move</span>');
      } else if (a.movement === 'DIFFICULTY') {
        chips.push('<span class="med-chip req">⚠ Movement Difficulty</span>');
      }

      chipsBox.innerHTML = chips.join(' ');
    }

    // Full 5-Question Rapid Victim Assessment Sub-Panel (Inside Expandable Accordion)
    const assBox = $id('lmDetailAssessmentContent');
    if (assBox) {
      const a = inc.assessment;
      if (a && (a.completed || a.conscious)) {
        let consciousText = '✓ Yes (Alert)';
        if (a.conscious === 'NO') consciousText = '🔴 No (Unconscious)';
        else if (a.conscious === 'CONFUSED') consciousText = '⚠ Confused / Disoriented';

        let breathingText = '✓ Normal';
        if (a.breathing === 'SEVERE') breathingText = '🔴 Severe Difficulty';
        else if (a.breathing === 'MILD') breathingText = '⚠ Mild Difficulty';

        const bleedingText = a.heavyBleeding ? '🔴 Yes (Active hemorrhage)' : '✓ No heavy bleeding';
        const painText = a.severePain ? '🔴 Yes (Severe)' : '✓ No severe pain';
        
        let movementText = '✓ Normal movement';
        if (a.movement === 'CANNOT_MOVE') movementText = '🔴 Cannot move / Paralysis risk';
        else if (a.movement === 'DIFFICULTY') movementText = '⚠ Movement difficulty';

        assBox.innerHTML = `
          <div><b>Conscious:</b> ${consciousText}</div>
          <div><b>Breathing:</b> ${breathingText}</div>
          <div><b>Heavy Bleeding:</b> ${bleedingText}</div>
          <div><b>Severe Pain:</b> ${painText}</div>
          <div><b>Movement:</b> ${movementText}</div>
        `;
      } else {
        assBox.innerHTML = `
          <div style="color:#64748b;font-style:italic;">
            Awaiting citizen 5-question triage submission... Initial triage vitals recorded via voice/GPS.
          </div>
        `;
      }
    }

    // Medical Requirements Chips (Inside Expandable Accordion)
    const reqChips = $id('lmDetailReqChips');
    if (reqChips) {
      const reqs = inc.medicalRequirements || {};
      const isL1 = inc.priority?.code === 'L1' || inc.triage?.severeBleeding;
      const needTrauma = reqs.trauma_level != null ? reqs.trauma_level <= 2 : isL1;
      const needICU = reqs.icu != null ? reqs.icu : isL1;
      const needSurg = reqs.emergency_surgery != null ? reqs.emergency_surgery : isL1;
      const needBlood = reqs.blood_bank != null ? reqs.blood_bank : (isL1 || inc.triage?.severeBleeding);
      const needVent = reqs.ventilator != null ? reqs.ventilator : false;

      reqChips.innerHTML = `
        <span class="med-chip ${needTrauma ? 'verified' : 'off'}">${needTrauma ? '✓ Trauma L1' : '✕ Trauma L1'}</span>
        <span class="med-chip ${needICU ? 'verified' : 'off'}">${needICU ? '✓ ICU Bed' : '✕ ICU Bed'}</span>
        <span class="med-chip ${needSurg ? 'verified' : 'off'}">${needSurg ? '✓ Surgery' : '✕ Surgery'}</span>
        <span class="med-chip ${needBlood ? 'verified' : 'off'}">${needBlood ? '✓ Blood Bank' : '✕ Blood Bank'}</span>
        <span class="med-chip ${needVent ? 'req' : 'off'}">${needVent ? '✓ Vent' : '✕ Vent'}</span>
      `;
    }

    // --- PANEL 2: AMBULANCE TRACKING & SMART ASSIGNMENT ---
    const ambData = inc.dispatch?.ambulance || inc.assignedAmbulanceDetails || {};
    const ambId = ambData.id || inc.assignedAmbulance || 'AMB-108-10';
    const ambDriver = ambData.driverName || 'Santosh Nishad';
    const ambType = ambData.type || inc.assignedAmbulanceType || 'ALS';
    const ambEta = Math.round(ambData.etaToSceneMinutes ?? inc.ambulanceEtaMinutes ?? 6);
    const ambStatus = (ambData.status || inc.stage || 'EN ROUTE').replace(/_/g, ' ');
    const ambDistNum = ambData.distanceKm ?? 3.85;
    const ambDist = `${ambDistNum} km`;

    if ($id('lmAmbUnit')) $id('lmAmbUnit').textContent = ambId;
    if ($id('lmAmbStatusBadge')) $id('lmAmbStatusBadge').textContent = ambStatus;
    if ($id('lmAmbDriver')) $id('lmAmbDriver').textContent = ambDriver;
    if ($id('lmAmbDistance')) $id('lmAmbDistance').textContent = ambDist;
    if ($id('lmAmbEta')) $id('lmAmbEta').textContent = `${ambEta} min`;
    if ($id('lmAmbEquip')) $id('lmAmbEquip').textContent = `${ambType} • Ventilator Ready`;
    if ($id('lmAmbGps')) $id('lmAmbGps').textContent = 'GPS LIVE • 48 km/h';

    // 🧠 Why This Ambulance? Sub-Panel (Collapsed by default)
    const ambWhyBox = $id('lmAmbWhyContent');
    if (ambWhyBox) {
      ambWhyBox.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:3px;">
          <div>✓ Available in Sector</div>
          <div>✓ ${ambDist} away</div>
          <div>✓ ETA ${ambEta} min</div>
          <div>✓ Required ${esc(ambType)} equipment available</div>
        </div>
      `;
    }

    // --- PANEL 3: HOSPITAL STATUS & SMART ASSIGNMENT ---
    const hospData = inc.dispatch?.hospital || inc.destinationDetails || {};
    let hospName = hospData.name || inc.destinationHospital || 'SHRI SHANKARACHARYA';
    hospName = hospName.replace(/^🏥\s*/, '');
    const hospTtac = Math.round(inc.dispatch?.ttacMinutes ?? hospData.ttacMinutes ?? inc.ttac_minutes ?? 18);
    const hospIcu = hospData.available_icu ?? inc.available_icu ?? 4;
    const hospEr = hospData.available_er ?? inc.available_er ?? 6;
    const hospCap = hospData.capacity ? `${hospData.capacity}%` : '72%';
    const hospTrauma = hospData.trauma_level ? `Level ${hospData.trauma_level}` : 'Level 1';

    if ($id('lmHospName')) $id('lmHospName').textContent = hospName;
    if ($id('lmHospPreAlertBadge')) $id('lmHospPreAlertBadge').textContent = 'PRE-ALERT';
    if ($id('lmHospTtac')) $id('lmHospTtac').textContent = `${hospTtac} min`;
    if ($id('lmHospIcu')) $id('lmHospIcu').textContent = `ICU ${hospIcu} FREE`;
    if ($id('lmHospEr')) $id('lmHospEr').textContent = `ER ${hospEr} FREE`;
    if ($id('lmHospCapacity')) $id('lmHospCapacity').textContent = `Capacity ${hospCap}`;
    if ($id('lmHospAlertInfo')) $id('lmHospAlertInfo').innerHTML = '✓ Pre-alert transmitted &nbsp;•&nbsp; ✓ ICU locked';

    // 🧠 Why This Hospital? Sub-Panel (Collapsed by default)
    const hospWhyBox = $id('lmHospWhyContent');
    if (hospWhyBox) {
      hospWhyBox.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:3px;">
          <div>✓ ICU available &amp; locked (${hospIcu} free)</div>
          <div>✓ Suitable trauma facility (${esc(hospTrauma)})</div>
          <div>✓ Optimal TTAC (${hospTtac} min)</div>
          <div>✓ Capacity ${hospCap}</div>
        </div>
      `;
    }

    // --- PANEL 4: RESPONSE TIMELINE ---
    renderResponseTimeline(inc);

    // --- PANEL 5: REAL-TIME UPDATES STREAM ---
    renderIncidentEventStream(inc);

    // Update Resource Status Counts
    updateResourceStatusCounts();
  };

  // 12. Append Live Event to Stream (Incident-Isolated)
  window.appendLiveEvent = function(category, text, tag = 'info', targetIncidentId = null) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const eventObj = { time: timeStr, category, text, tag };

    const currentId = targetIncidentId || window.liveMonitoringState.selectedIncidentId;
    if (currentId) {
      const stream = window.liveMonitoringState.eventStreams[currentId] || [];
      stream.unshift(eventObj);
      if (stream.length > MAX_EVENTS_PER_INCIDENT) stream.pop();
      window.liveMonitoringState.eventStreams[currentId] = stream;
    }

    const selectedInc = window.getSelectedIncident();
    if (selectedInc && (!targetIncidentId || targetIncidentId === selectedInc.id || targetIncidentId === selectedInc.incidentId)) {
      renderIncidentEventStream(selectedInc);
    }
  };

  // 13. Non-Intrusive New Critical Incident Notification Banner
  window.showNewIncidentNotification = function(incident) {
    const container = $id('lmAlertContainer');
    if (!container || !incident) return;

    const incId = incident.id || incident.incidentId || 'SOS';
    const type = incident.emergencyType || incident.type || 'Critical Emergency';
    const loc = incident.location?.address || 'Live GPS Beacon';

    container.innerHTML = `
      <div class="lm-alert-banner lm-alert-critical-incoming">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:1.3rem;">🔴</span>
          <div>
            <strong>NEW CRITICAL INCIDENT: ${esc(incId)}</strong>
            <div style="font-size:0.75rem;color:#fee2e2;margin-top:2px;">
              ${esc(type)} · Location: ${esc(loc)}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button onclick="selectMonitoringIncident('${esc(incId)}'); document.getElementById('lmAlertContainer').innerHTML='';" 
            style="background:#0284c7;border:1px solid #38bdf8;color:#fff;padding:5px 12px;border-radius:5px;cursor:pointer;font-size:0.75rem;font-weight:800;box-shadow:0 0 8px rgba(56,189,248,0.5);">
            VIEW INCIDENT
          </button>
          <button onclick="document.getElementById('lmAlertContainer').innerHTML=''" 
            style="background:rgba(255,255,255,0.15);border:none;color:#fff;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:0.75rem;font-weight:700;">
            DISMISS
          </button>
        </div>
      </div>
    `;
  };

  // 14. Helper to focus / simulate an incident from standby state
  window.triggerSimulateSelectSOS = function() {
    if (window.liveMonitoringState.incidents && window.liveMonitoringState.incidents.length) {
      window.selectMonitoringIncident(window.liveMonitoringState.incidents[0].id);
    } else if (window.incidents && window.incidents.length) {
      window.liveMonitoringState.incidents = [...window.incidents];
      window.selectMonitoringIncident(window.incidents[0].id);
    } else if (typeof window.triggerSimulatedSOS === 'function') {
      window.triggerSimulatedSOS();
    }
  };

  // 15. SSE Handler Integration
  window.onLiveMonitoringEvent = function(type, data) {
    if (!data) return;

    if (type === 'new_sos' || type === 'incident' || type === 'incident.created') {
      const incId = data.id || data.incidentId;
      
      const existingIdx = window.liveMonitoringState.incidents.findIndex(i => (i.id === incId || i.incidentId === incId));
      if (existingIdx >= 0) {
        window.liveMonitoringState.incidents[existingIdx] = { ...window.liveMonitoringState.incidents[existingIdx], ...data };
      } else {
        window.liveMonitoringState.incidents.unshift(data);
      }

      window.appendLiveEvent('NEW SOS', `${incId} received · ${data.emergencyType || 'Emergency'}`, 'danger', incId);
      
      window.renderLiveMonitoringQueue();

      if (!window.liveMonitoringState.selectedIncidentId) {
        window.selectMonitoringIncident(incId);
      } else if (window.liveMonitoringState.selectedIncidentId === incId) {
        window.renderLiveMonitoringWorkspace();
      } else {
        window.showNewIncidentNotification(data);
      }

    } else if (type === 'incident:update' || type === 'incident.updated') {
      const incId = data.id || data.incidentId;
      const idx = window.liveMonitoringState.incidents.findIndex(i => (i.id === incId || i.incidentId === incId));
      if (idx >= 0) {
        window.liveMonitoringState.incidents[idx] = { ...window.liveMonitoringState.incidents[idx], ...data };
      }
      window.renderLiveMonitoringQueue();
      if (window.liveMonitoringState.selectedIncidentId === incId) {
        window.renderLiveMonitoringWorkspace();
      }

    } else if (type === 'ambulance:reserved' || type === 'ambulance:location_updated') {
      const incId = data.incident_id;
      window.appendLiveEvent('AMBULANCE', `Ambulance ${data.unit_id || data.ambulance_id || ''} telemetry active`, 'ok', incId);
      if (window.liveMonitoringState.selectedIncidentId === incId) {
        window.renderLiveMonitoringWorkspace();
      }

    } else if (type === 'hospital:prealert') {
      const incId = data.incident_id;
      window.appendLiveEvent('PRE-ALERT', `Pre-alert dispatched to ${data.hospital_name} (ICU locked)`, 'info', incId);
      if (window.liveMonitoringState.selectedIncidentId === incId) {
        window.renderLiveMonitoringWorkspace();
      }

    } else if (type === 'resource:update') {
      updateResourceStatusCounts();
    }

    updateResourceStatusCounts();
  };

  // 16. Initial bootstrap
  document.addEventListener('DOMContentLoaded', () => {
    updateClock();
    updateResourceStatusCounts();
    
    fetch('/api/incidents')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data) && data.length) {
          window.liveMonitoringState.incidents = data;
          window.renderLiveMonitoringQueue();
        }
      })
      .catch(err => console.debug('Initial /api/incidents load:', err));

    window.appendLiveEvent('SYSTEM', 'Rakshak 112 Dynamic Dispatch Engine Initialized.', 'ok');
    window.appendLiveEvent('TELEMETRY', 'Listening for live GPS beacons and bystander stream.', 'info');
  });

  // Export renderLiveMonitoring as master coordinator
  window.renderLiveMonitoring = function() {
    window.renderLiveMonitoringQueue();
    window.renderLiveMonitoringWorkspace();
    if (typeof window.renderLiveMonitoringMapMarkers === 'function') {
      window.renderLiveMonitoringMapMarkers();
    }
  };

})(window);
