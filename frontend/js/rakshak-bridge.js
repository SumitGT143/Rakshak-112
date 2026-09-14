/**
 * Rakshak 112 — rakshak-bridge.js (BACKEND-ONLY VERSION)
 * Replaced BroadcastChannel/LocalStorage with Server-Sent Events + REST API.
 * Single source of truth: backend serve_and_open.py at /api/events and /api/sos.
 */

(function(window) {
  'use strict';

  const RakshakBridge = {
    // SSE stream for real-time updates from backend
    _es: null,
    _callbacks: {},

    init: function(callbacks) {
      this._callbacks = callbacks || {};
      // Use backend SSE — NO BroadcastChannel, NO LocalStorage
      try {
        if (typeof EventSource !== 'undefined') {
          this._es = new EventSource('/api/events');
          this._es.addEventListener('ready', () => {
            console.log('✅ [RakshakBridge] SSE connected to backend /api/events');
          });
          this._es.addEventListener('incident', e => this._handle('incident', e));
          this._es.addEventListener('incident:update', e => this._handle('incident:update', e));
          this._es.addEventListener('incident:assessment', e => this._handle('incident:assessment', e));
          this._es.addEventListener('new_sos', e => this._handle('new_sos', e));
          this._es.addEventListener('dispatch', e => this._handle('dispatch', e));
          this._es.addEventListener('ambulance:reserved', e => this._handle('ambulance:reserved', e));
          this._es.addEventListener('hospital:prealert', e => this._handle('hospital:prealert', e));
          this._es.addEventListener('hospital:acknowledged', e => this._handle('hospital:acknowledged', e));
          this._es.addEventListener('hospital:reassigned', e => this._handle('hospital:reassigned', e));
          this._es.addEventListener('anomaly:movement', e => this._handle('anomaly:movement', e));
          this._es.addEventListener('dispatch:reoptimized', e => this._handle('dispatch:reoptimized', e));
          this._es.addEventListener('resource:update', e => this._handle('resource:update', e));
          this._es.onerror = () => console.warn('⚠ [RakshakBridge] SSE error — reconnecting...');
        }
      } catch (e) {
        console.warn('EventSource unavailable:', e);
      }
    },

    _handle: function(type, event) {
      try {
        const data = JSON.parse(event.data);
        if (typeof window.onLiveMonitoringEvent === 'function') {
          window.onLiveMonitoringEvent(type, data);
        }
        if (type === 'incident' || type === 'new_sos') {
          if (typeof this._callbacks.onSOSReceived === 'function') this._callbacks.onSOSReceived(data);
        } else if (type === 'incident:update' || type === 'hospital:reassigned' || type === 'dispatch:reoptimized') {
          if (typeof this._callbacks.onStatusUpdate === 'function') this._callbacks.onStatusUpdate(data);
        } else if (type === 'dispatch') {
          if (typeof this._callbacks.onDispatchReceived === 'function') this._callbacks.onDispatchReceived(data);
        }
      } catch (err) { console.warn('SSE parse error in bridge:', err); }
    },

    // Send SOS to backend via REST — no browser-to-browser
    sendSOS: async function(sosData) {
      try {
        const res = await fetch('/api/sos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sosData)
        });
        const data = await res.json();
        console.log('📡 [RakshakBridge] SOS sent to backend /api/sos:', data);
        return data;
      } catch (e) {
        console.error('❌ [RakshakBridge] SOS POST failed:', e);
        return null;
      }
    },

    notifyDispatch: function() {
      // Dispatch notifications now come through SSE /api/events from backend
      // No direct browser-to-browser notification required
      console.log('📡 [RakshakBridge] Dispatch updates delivered via SSE from /api/events');
    },

    notifyGreenCorridor: function() {
      console.log('📡 [RakshakBridge] Green corridor updates delivered via SSE from /api/events');
    },

    notifyStatus: function() {
      console.log('📡 [RakshakBridge] Status updates delivered via SSE from /api/events');
    }
  };

  window.RakshakBridge = RakshakBridge;
})(window);
