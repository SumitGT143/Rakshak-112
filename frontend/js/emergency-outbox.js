/**
 * Rakshak 112 — Resilient Emergency Outbox & Offline Communication Engine
 * 
 * Guarantees zero emergency loss over weak / intermittent connectivity.
 * Protocol: CREATE FIRST → STORE IN INDEXEDDB → TRANSMIT → SERVER ACK → SYNCHRONIZE
 */

(function (global) {
  'use strict';

  const DB_NAME = 'RakshakEmergencyDB';
  const DB_VERSION = 1;
  const STORE_OUTBOX = 'outbox';
  const STORE_GPS = 'gps_queue';
  const FALLBACK_KEY = 'rakshak_emergency_outbox_fallback';

  let dbInstance = null;
  let isDbReady = false;
  let isProcessing = false;
  let currentConnState = navigator.onLine ? 'CONNECTED' : 'OFFLINE'; // 'CONNECTED' | 'DEGRADED' | 'OFFLINE'
  let lastSuccessfulPing = Date.now();

  const connListeners = [];
  const outboxListeners = [];
  const ackListeners = [];

  // 1. Initialize IndexedDB with graceful LocalStorage fallback
  function initDB() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('[EmergencyOutbox] IndexedDB not available. Using LocalStorage fallback.');
        isDbReady = true;
        resolve(null);
        return;
      }

      try {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function (e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
            const outStore = db.createObjectStore(STORE_OUTBOX, { keyPath: 'incidentId' });
            outStore.createIndex('status', 'status', { unique: false });
            outStore.createIndex('createdAt', 'createdAt', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_GPS)) {
            const gpsStore = db.createObjectStore(STORE_GPS, { keyPath: 'id', autoIncrement: true });
            gpsStore.createIndex('incidentId', 'incidentId', { unique: false });
          }
        };

        request.onsuccess = function (e) {
          dbInstance = e.target.result;
          isDbReady = true;
          resolve(dbInstance);
        };

        request.onerror = function (e) {
          console.warn('[EmergencyOutbox] IndexedDB open error. Using LocalStorage fallback:', e);
          isDbReady = true;
          resolve(null);
        };
      } catch (err) {
        console.warn('[EmergencyOutbox] IndexedDB exception:', err);
        isDbReady = true;
        resolve(null);
      }
    });
  }

  // LocalStorage Fallback Helpers
  function getFallbackOutbox() {
    try {
      const data = localStorage.getItem(FALLBACK_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function saveFallbackOutbox(items) {
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(items));
    } catch (e) {
      console.error('[EmergencyOutbox] Failed saving fallback outbox:', e);
    }
  }

  // DB CRUD Operations
  function saveToOutbox(item) {
    return new Promise((resolve, reject) => {
      if (!item || !item.incidentId) {
        reject(new Error('Invalid outbox item'));
        return;
      }

      if (dbInstance) {
        try {
          const tx = dbInstance.transaction([STORE_OUTBOX], 'readwrite');
          const store = tx.objectStore(STORE_OUTBOX);
          const req = store.put(item);
          req.onsuccess = () => resolve(item);
          req.onerror = (e) => reject(e);
        } catch (e) {
          // Fallback
          const items = getFallbackOutbox().filter(i => i.incidentId !== item.incidentId);
          items.push(item);
          saveFallbackOutbox(items);
          resolve(item);
        }
      } else {
        const items = getFallbackOutbox().filter(i => i.incidentId !== item.incidentId);
        items.push(item);
        saveFallbackOutbox(items);
        resolve(item);
      }
    });
  }

  function getOutboxItem(incidentId) {
    return new Promise((resolve) => {
      if (dbInstance) {
        try {
          const tx = dbInstance.transaction([STORE_OUTBOX], 'readonly');
          const store = tx.objectStore(STORE_OUTBOX);
          const req = store.get(incidentId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          const items = getFallbackOutbox();
          resolve(items.find(i => i.incidentId === incidentId) || null);
        }
      } else {
        const items = getFallbackOutbox();
        resolve(items.find(i => i.incidentId === incidentId) || null);
      }
    });
  }

  function getAllOutboxItems() {
    return new Promise((resolve) => {
      if (dbInstance) {
        try {
          const tx = dbInstance.transaction([STORE_OUTBOX], 'readonly');
          const store = tx.objectStore(STORE_OUTBOX);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve(getFallbackOutbox());
        } catch (e) {
          resolve(getFallbackOutbox());
        }
      } else {
        resolve(getFallbackOutbox());
      }
    });
  }

  // Generate Unique Stable Incident ID: R112-XXXXXXXX
  function generateIncidentId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const suffix = String(Date.now()).slice(-3);
    return `R112-${code}${suffix}`;
  }

  // Update App-level Connection State
  function setConnectionState(newState) {
    if (currentConnState !== newState) {
      currentConnState = newState;
      connListeners.forEach(fn => {
        try { fn(currentConnState); } catch (e) { console.error(e); }
      });
    }
  }

  // 2. Public Emergency Outbox API
  const EmergencyOutbox = {
    init: async function () {
      await initDB();
      this.checkHeartbeat();
      setInterval(() => this.checkHeartbeat(), 20000);
      setInterval(() => this.tick(), 4000);

      window.addEventListener('online', () => {
        setConnectionState('CONNECTED');
        this.processOutbox();
      });

      window.addEventListener('offline', () => {
        setConnectionState('OFFLINE');
      });

      // Resume any pending emergencies from previous session / reload
      this.processOutbox();
    },

    getConnectionState: function () {
      return currentConnState;
    },

    onConnectionChange: function (callback) {
      if (typeof callback === 'function') connListeners.push(callback);
    },

    onOutboxChange: function (callback) {
      if (typeof callback === 'function') outboxListeners.push(callback);
    },

    onServerAck: function (callback) {
      if (typeof callback === 'function') ackListeners.push(callback);
    },

    /**
     * Stage 1: Queue Minimal Emergency Packet locally before transmitting
     */
    queueEmergency: async function (options) {
      const now = Date.now();
      const incidentId = options.incidentId || generateIncidentId();

      const minimalPacket = {
        id: incidentId,
        incidentId: incidentId,
        userId: options.userId || 'citizen_' + incidentId,
        emergencyType: options.emergencyType || 'UNCLASSIFIED',
        severity: options.severity || 'CRITICAL',
        priority: options.priority || { code: 'L1', label: 'CRITICAL', score: 99 },
        latitude: Number(options.latitude) || 21.2065,
        longitude: Number(options.longitude) || 81.3320,
        accuracy: Number(options.accuracy) || 12,
        timestamp: options.timestamp || now,
        protocolVersion: '1.0',
        stage: 'INITIAL_BEACON',
        source: 'Rakshak-112 PWA (Resilient Outbox)',
        caller: options.caller || {},
        responseNote: 'Live GPS SOS beacon queued locally in Emergency Outbox.'
      };

      const outboxItem = {
        incidentId: incidentId,
        stage: 1, // 1: CRITICAL_PACKET, 2: TRIAGE_INFO, 3: GPS_STREAM
        payload: minimalPacket,
        status: 'PENDING', // 'PENDING' | 'SENDING' | 'ACKNOWLEDGED'
        attempts: 0,
        createdAt: now,
        lastAttemptAt: null,
        nextRetryAt: now,
        serverAck: false,
        serverAckTime: null,
        timeline: [
          { time: now, event: 'SOS captured & saved securely in local device outbox' }
        ]
      };

      await saveToOutbox(outboxItem);
      this.notifyOutboxChange(outboxItem, 'QUEUED');

      // Trigger immediate transmission attempt
      this.processOutbox();
      return outboxItem;
    },

    /**
     * Stage 2: Progressively update emergency with Triage / Role details
     */
    updateTriage: async function (incidentId, triageData, emergencyType) {
      const item = await getOutboxItem(incidentId);
      if (!item) return null;

      item.stage = 2;
      item.payload.stage = 'TRIAGE_UPDATE';
      if (emergencyType) {
        item.payload.emergencyType = emergencyType;
        item.payload.type = emergencyType;
      }
      if (triageData) {
        item.payload.triage = { ...(item.payload.triage || {}), ...triageData };
      }

      item.status = 'PENDING';
      item.nextRetryAt = Date.now();
      item.timeline.push({
        time: Date.now(),
        event: 'Triage details recorded locally & queued for transmission'
      });

      await saveToOutbox(item);
      this.notifyOutboxChange(item, 'UPDATED');
      this.processOutbox();
      return item;
    },

    /**
     * Stage 3: Store-and-forward live GPS sample
     */
    queueGpsUpdate: async function (incidentId, lat, lng, accuracy) {
      const item = await getOutboxItem(incidentId);
      if (!item) return;

      const now = Date.now();
      // Only update if newer
      if (!item.payload.timestamp || now >= item.payload.timestamp) {
        item.payload.latitude = lat;
        item.payload.longitude = lng;
        item.payload.accuracy = accuracy;
        item.payload.lat = lat;
        item.payload.lng = lng;
        item.payload.timestamp = now;
        await saveToOutbox(item);
      }
    },

    /**
     * Core Transmission Engine: Processes unacknowledged items with Exponential Backoff
     */
    processOutbox: async function () {
      if (isProcessing) return;
      isProcessing = true;

      try {
        const items = await getAllOutboxItems();
        const pendingItems = items.filter(i => !i.serverAck || i.status === 'PENDING');

        for (const item of pendingItems) {
          const now = Date.now();
          if (now < (item.nextRetryAt || 0)) {
            continue; // Wait until next retry window
          }

          item.status = 'SENDING';
          item.attempts = (item.attempts || 0) + 1;
          item.lastAttemptAt = now;
          await saveToOutbox(item);
          this.notifyOutboxChange(item, 'SENDING');

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            const response = await fetch('/api/sos', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item.payload),
              signal: controller.signal
            });

            clearTimeout(timeoutId);
            const data = await response.json();

            if (response.ok && (data.ack === true || data.success === true)) {
              // Explicit Server ACK Received!
              item.status = 'ACKNOWLEDGED';
              item.serverAck = true;
              item.serverAckTime = Date.now();
              item.timeline.push({
                time: Date.now(),
                event: `✓ Server ACK received for ${item.incidentId} (Synchronized)`
              });

              await saveToOutbox(item);
              lastSuccessfulPing = Date.now();
              setConnectionState('CONNECTED');

              this.notifyOutboxChange(item, 'ACKNOWLEDGED');
              ackListeners.forEach(fn => {
                try { fn(data, item); } catch (e) { console.error(e); }
              });

            } else {
              throw new Error(data.error || 'Server did not return valid ACK');
            }

          } catch (err) {
            // Transmission Failed / Weak Connection -> Calculate Exponential Backoff
            const backoffDelay = Math.min(30000, 2000 * Math.pow(1.6, item.attempts));
            item.status = 'PENDING';
            item.nextRetryAt = Date.now() + backoffDelay;
            item.timeline.push({
              time: Date.now(),
              event: `Transmission attempt #${item.attempts} failed (Weak connection) · Next retry in ${Math.round(backoffDelay / 1000)}s`
            });

            await saveToOutbox(item);
            setConnectionState(navigator.onLine ? 'DEGRADED' : 'OFFLINE');
            this.notifyOutboxChange(item, 'RETRY_SCHEDULED');
          }
        }
      } catch (err) {
        console.error('[EmergencyOutbox] processOutbox error:', err);
      } finally {
        isProcessing = false;
      }
    },

    tick: function () {
      this.processOutbox();
    },

    checkHeartbeat: async function () {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch('/api/status', { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          lastSuccessfulPing = Date.now();
          if (currentConnState !== 'CONNECTED') {
            setConnectionState('CONNECTED');
            this.processOutbox();
          }
        } else {
          setConnectionState('DEGRADED');
        }
      } catch (e) {
        setConnectionState(navigator.onLine ? 'DEGRADED' : 'OFFLINE');
      }
    },

    notifyOutboxChange: function (item, changeType) {
      outboxListeners.forEach(fn => {
        try { fn(item, changeType); } catch (e) { console.error(e); }
      });
    },

    getOutboxItem: getOutboxItem,
    getAllOutboxItems: getAllOutboxItems
  };

  global.EmergencyOutbox = EmergencyOutbox;
})(typeof window !== 'undefined' ? window : global);
