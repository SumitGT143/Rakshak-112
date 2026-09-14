/**
 * Rakshak 112 — Offline-First Internationalization (i18n) Engine
 * 
 * 100% Zero-Network Dependency: All 23 languages pre-bundled locally.
 * Single source of truth for supported languages, translations, persistence, and direction.
 */

(function (global) {
  'use strict';

  // Persistence Key
  const LANGUAGE_STORAGE_KEY = 'rakshak_language';

  // Central Single Source of Truth for all 23 Supported Languages
  const supportedLanguages = [
    { code: 'en', name: 'English', nativeName: 'English', direction: 'ltr', aliases: ['english', 'en'] },
    { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', direction: 'ltr', aliases: ['hindi', 'devanagari', 'hi'] },
    { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', direction: 'ltr', aliases: ['bengali', 'bangla', 'bn'] },
    { code: 'mr', name: 'Marathi', nativeName: 'मराठी', direction: 'ltr', aliases: ['marathi', 'mr'] },
    { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', direction: 'ltr', aliases: ['telugu', 'te'] },
    { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', direction: 'ltr', aliases: ['tamil', 'ta'] },
    { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', direction: 'ltr', aliases: ['gujarati', 'gu'] },
    { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', direction: 'ltr', aliases: ['kannada', 'kn'] },
    { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', direction: 'ltr', aliases: ['malayalam', 'ml'] },
    { code: 'or', name: 'Odia', nativeName: 'ଓଡ଼ିଆ', direction: 'ltr', aliases: ['odia', 'oriya', 'or'] },
    { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', direction: 'ltr', aliases: ['punjabi', 'gurmukhi', 'pa'] },
    { code: 'as', name: 'Assamese', nativeName: 'অসমীয়া', direction: 'ltr', aliases: ['assamese', 'asomiya', 'as'] },
    { code: 'mai', name: 'Maithili', nativeName: 'मैथिली', direction: 'ltr', aliases: ['maithili', 'mithila', 'mai'] },
    { code: 'sat', name: 'Santali', nativeName: 'ᱥᱟᱱᱛᱟᱲᱤ', direction: 'ltr', aliases: ['santali', 'ol chiki', 'sat'] },
    { code: 'ks', name: 'Kashmiri', nativeName: 'کٲشُر / कॉशुर', direction: 'rtl', aliases: ['kashmiri', 'koshur', 'ks'] },
    { code: 'ne', name: 'Nepali', nativeName: 'नेपाली', direction: 'ltr', aliases: ['nepali', 'ne'] },
    { code: 'kok', name: 'Konkani', nativeName: 'कोंकणी', direction: 'ltr', aliases: ['konkani', 'kok'] },
    { code: 'mni', name: 'Manipuri', nativeName: 'মৈতৈলোন্', direction: 'ltr', aliases: ['manipuri', 'meitei', 'mni'] },
    { code: 'doi', name: 'Dogri', nativeName: 'डोगरी', direction: 'ltr', aliases: ['dogri', 'doi'] },
    { code: 'sd', name: 'Sindhi', nativeName: 'سنڌي / सिन्धी', direction: 'rtl', aliases: ['sindhi', 'sd'] },
    { code: 'brx', name: 'Bodo', nativeName: 'बर\'', direction: 'ltr', aliases: ['bodo', 'boro', 'brx'] },
    { code: 'gon', name: 'Gondi', nativeName: 'गोण्डी', direction: 'ltr', aliases: ['gondi', 'gon'] },
    { code: 'bhb', name: 'Bhili', nativeName: 'भीली', direction: 'ltr', aliases: ['bhili', 'bhil', 'bhb'] }
  ];

  let currentLanguage = 'en';
  const changeListeners = [];

  /**
   * Safe deep lookup in an object using dot notation
   */
  function getNestedValue(obj, keyPath) {
    if (!obj || typeof obj !== 'object' || !keyPath) return undefined;
    const parts = keyPath.split('.');
    let current = obj;
    for (let i = 0; i < parts.length; i++) {
      if (current === undefined || current === null) return undefined;
      current = current[parts[i]];
    }
    return current;
  }

  /**
   * Interpolate parameters into string: {{param}}
   */
  function interpolate(template, params) {
    if (typeof template !== 'string') return template;
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (match, key) {
      const val = params[key];
      return val !== undefined && val !== null ? String(val) : match;
    });
  }

  const RakshakI18n = {
    /**
     * Array of supported languages
     */
    supportedLanguages: supportedLanguages,

    /**
     * Storage key used for localStorage
     */
    storageKey: LANGUAGE_STORAGE_KEY,

    /**
     * Get active language code
     */
    getLanguage: function () {
      return currentLanguage;
    },

    /**
     * Get active language configuration object
     */
    getCurrentLanguageInfo: function () {
      return this.getLanguageInfo(currentLanguage);
    },

    /**
     * Get language info by code
     */
    getLanguageInfo: function (code) {
      const target = (code || currentLanguage).toLowerCase();
      return supportedLanguages.find(lang => lang.code.toLowerCase() === target) || supportedLanguages[0];
    },

    /**
     * Check if a language code is supported
     */
    isSupported: function (code) {
      if (!code || typeof code !== 'string') return false;
      const target = code.trim().toLowerCase();
      return supportedLanguages.some(lang => lang.code.toLowerCase() === target);
    },

    /**
     * Main translation function with fallback chain:
     * 1. Selected language dictionary
     * 2. English dictionary
     * 3. Default value / key itself
     */
    t: function (key, params) {
      if (!key) return '';
      const locales = global.RakshakLocales || {};
      
      const currentDict = locales[currentLanguage];
      let value = getNestedValue(currentDict, key);

      // Fallback 1: English
      if (value === undefined && currentLanguage !== 'en') {
        const enDict = locales['en'];
        value = getNestedValue(enDict, key);
      }

      // Fallback 2: Default value or key
      if (value === undefined) {
        if (params && params.defaultValue !== undefined) {
          value = params.defaultValue;
        } else {
          value = key;
        }
      }

      if (typeof value === 'string') {
        return interpolate(value, params);
      }

      return value;
    },

    /**
     * Set active language (100% offline, zero network calls, updates DOM in-place)
     */
    setLanguage: function (code) {
      const normalizedCode = (code || '').trim().toLowerCase();
      const langConfig = supportedLanguages.find(l => l.code === normalizedCode);

      if (!langConfig) {
        console.warn(`[RakshakI18n] Unsupported language code: ${code}. Falling back to English.`);
        currentLanguage = 'en';
      } else {
        currentLanguage = langConfig.code;
      }

      // Persist locally
      try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguage);
      } catch (e) {
        console.error('[RakshakI18n] Error saving language to localStorage:', e);
      }

      // Update HTML lang and direction attributes
      const activeLang = this.getCurrentLanguageInfo();
      document.documentElement.lang = activeLang.code;
      document.documentElement.dir = activeLang.direction || 'ltr';

      // Re-render all data-i18n DOM elements
      this.applyTranslations();

      // Update UI components
      this.updateLanguageDisplay();
      this.renderLanguageSelectionModal();

      // Trigger change listeners
      changeListeners.forEach(fn => {
        try {
          fn(currentLanguage, activeLang);
        } catch (err) {
          console.error('[RakshakI18n] Listener callback error:', err);
        }
      });

      return currentLanguage;
    },

    /**
     * Register a callback for language changes
     */
    onLanguageChange: function (callback) {
      if (typeof callback === 'function') {
        changeListeners.push(callback);
      }
    },

    /**
     * Automatically update all elements with data-i18n attributes
     */
    applyTranslations: function (root) {
      const scope = root || document;

      // Text / HTML Content
      scope.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;

        const translation = this.t(key);
        if (translation !== undefined) {
          // If translation contains HTML tags (e.g. <b>, <br>, <i>), use innerHTML safely
          if (/<[a-z][\s\S]*>/i.test(translation)) {
            el.innerHTML = translation;
          } else {
            el.textContent = translation;
          }
        }
      });

      // Placeholders
      scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (!key) return;
        const translation = this.t(key);
        if (translation) el.setAttribute('placeholder', translation);
      });

      // Titles
      scope.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (!key) return;
        const translation = this.t(key);
        if (translation) el.setAttribute('title', translation);
      });

      // ARIA labels
      scope.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria');
        if (!key) return;
        const translation = this.t(key);
        if (translation) el.setAttribute('aria-label', translation);
      });
    },

    /**
     * Update the displayed selected language in Profile -> Preferences
     */
    updateLanguageDisplay: function () {
      const displayEl = document.getElementById('profileCurrentLanguageDisplay');
      if (displayEl) {
        const info = this.getCurrentLanguageInfo();
        if (info.code === 'en') {
          displayEl.textContent = 'English';
        } else {
          displayEl.textContent = `${info.name} / ${info.nativeName}`;
        }
      }
    },

    /**
     * Offline search filter for languages
     */
    filterLanguages: function (query) {
      const q = (query || '').trim().toLowerCase();
      if (!q) return supportedLanguages;

      return supportedLanguages.filter(lang => {
        if (lang.code.toLowerCase().includes(q)) return true;
        if (lang.name.toLowerCase().includes(q)) return true;
        if (lang.nativeName.toLowerCase().includes(q)) return true;
        if (lang.aliases && lang.aliases.some(alias => alias.toLowerCase().includes(q))) return true;
        return false;
      });
    },

    /**
     * Render the 23-language list in the Selection Modal
     */
    renderLanguageSelectionModal: function (filterQuery) {
      const container = document.getElementById('languageListContainer');
      if (!container) return;

      const filtered = this.filterLanguages(filterQuery);

      if (filtered.length === 0) {
        container.innerHTML = `
          <div style="text-align:center;padding:24px 16px;color:var(--muted);font-size:13px;">
            ${this.t('languageModal.noResults', { query: escapeHtml(filterQuery || '') })}
          </div>
        `;
        return;
      }

      container.innerHTML = filtered.map(lang => {
        const isSelected = lang.code === currentLanguage;
        const selectedClass = isSelected ? 'selected' : '';
        const checkmark = isSelected ? '<span class="lang-check" style="font-size:16px;font-weight:900;color:var(--crimson)">✓</span>' : '<span style="width:16px"></span>';

        return `
          <button type="button" class="lang-item-btn ${selectedClass}" onclick="RakshakI18n.selectLanguageAndClose('${lang.code}')" style="
            display:flex;align-items:center;justify-content:space-between;width:100%;
            padding:14px 16px;border-radius:16px;border:1.5px solid ${isSelected ? 'var(--crimson)' : 'rgba(0,0,0,0.08)'};
            background:${isSelected ? 'var(--crimson-soft)' : 'var(--card)'};
            color:${isSelected ? 'var(--crimson)' : 'var(--ink)'};
            cursor:pointer;transition:all .15s ease;text-align:left;gap:12px;
          ">
            <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1">
              <span style="font-size:18px;display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:${isSelected ? '#fff' : 'var(--surface)'};color:var(--crimson);font-weight:800">
                ${lang.code.toUpperCase()}
              </span>
              <div style="min-width:0;flex:1">
                <div style="font-size:15px;font-weight:800;letter-spacing:0.2px">${escapeHtml(lang.nativeName)}</div>
                <div style="font-size:11.5px;color:var(--muted);margin-top:2px">${escapeHtml(lang.name)}</div>
              </div>
            </div>
            ${checkmark}
          </button>
        `;
      }).join('');
    },

    /**
     * User selection handler: sets language, closes modal, shows feedback toast
     */
    selectLanguageAndClose: function (code) {
      const prevLang = currentLanguage;
      this.setLanguage(code);

      const info = this.getCurrentLanguageInfo();
      if (typeof global.closeLanguageModal === 'function') {
        global.closeLanguageModal();
      }

      if (typeof global.toast === 'function' && prevLang !== code) {
        global.toast(this.t('toasts.languageChanged', { name: `${info.name} (${info.nativeName})` }));
      }
    },

    /**
     * Validate key parity against English (for development audit)
     */
    validateKeyParity: function () {
      const locales = global.RakshakLocales || {};
      const enDict = locales['en'];
      if (!enDict) {
        console.error('[RakshakI18n] English master locale not found.');
        return;
      }

      function getAllKeys(obj, prefix = '') {
        let keys = [];
        for (const k in obj) {
          if (typeof obj[k] === 'object' && obj[k] !== null) {
            keys = keys.concat(getAllKeys(obj[k], prefix ? `${prefix}.${k}` : k));
          } else {
            keys.push(prefix ? `${prefix}.${k}` : k);
          }
        }
        return keys;
      }

      const enKeys = getAllKeys(enDict);
      console.log(`[RakshakI18n] English Master contains ${enKeys.length} translation keys.`);

      const report = {};
      supportedLanguages.forEach(lang => {
        if (lang.code === 'en') return;
        const dict = locales[lang.code] || {};
        const langKeys = getAllKeys(dict);
        const missing = enKeys.filter(k => !langKeys.includes(k));
        report[lang.code] = {
          name: lang.name,
          totalKeys: langKeys.length,
          missingKeysCount: missing.length,
          missingKeys: missing
        };
      });

      console.table(Object.keys(report).map(c => ({
        Code: c,
        Language: report[c].name,
        Total: report[c].totalKeys,
        Missing: report[c].missingKeysCount
      })));

      return report;
    },

    /**
     * Initialize i18n engine on startup
     */
    init: function () {
      let saved = null;
      try {
        saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      } catch (e) {
        console.error('[RakshakI18n] Error accessing localStorage:', e);
      }

      // Validate saved language against supported languages
      if (saved && this.isSupported(saved)) {
        currentLanguage = saved.toLowerCase();
      } else {
        currentLanguage = 'en';
      }

      const activeLang = this.getCurrentLanguageInfo();
      document.documentElement.lang = activeLang.code;
      document.documentElement.dir = activeLang.direction || 'ltr';

      this.applyTranslations();
      this.updateLanguageDisplay();
      this.renderLanguageSelectionModal();

      console.log(`[RakshakI18n] Initialized successfully with language: ${activeLang.name} (${activeLang.code}), Direction: ${activeLang.direction}`);
    }
  };

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
  }

  // Export globally
  global.RakshakI18n = RakshakI18n;
  global.t = function (key, params) {
    return RakshakI18n.t(key, params);
  };

})(typeof window !== 'undefined' ? window : this);
