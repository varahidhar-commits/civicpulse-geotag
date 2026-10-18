// CivicPulse multilingual UI engine.
// English is the canonical UI source. Tamil and Hindi dictionaries live in translations.js.
// User-written complaint details, names, addresses and free-text responses are NOT translated.
(function () {
  'use strict';
  const LANGUAGES = { en: 'English', ta: 'தமிழ்', hi: 'हिन्दी' };
  const dict = window.CIVIC_TRANSLATIONS || {};
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();
  let language = LANGUAGES[localStorage.getItem('civic_language')]
    ? localStorage.getItem('civic_language') : 'en';
  let observer;
  const excluded = '.complaint-desc,.complaint-title,.user-chip .avatar,.leaderboard-row .name,[data-no-translate],[contenteditable]';
  function isExcluded(el) {
    if (!el || !el.closest) return false;
    const blocking = el.closest(excluded);
    return Boolean(blocking && !el.closest('[data-i18n-allow]'));
  }
  const attrNames = ['placeholder', 'title', 'aria-label'];
  const emojiStart = /^((?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)+)(.*)$/u;
  const segments = [
    ['My tasks — ', 'My tasks'], ['Welcome, ', 'Welcome'],
    ['Assigned worker: ', 'Assigned worker'], ['Start deadline: ', 'Start deadline'],
    ['Assigned to ', 'Assigned to'], ['Reported by ', 'Reported by'],
    ['From ', 'From'], ['Near ', 'Near'], ['Official response: ', 'Official response'],
    ['Time remaining: ', 'Time remaining'], ['Overdue by ', 'Overdue by'],
    ['Worker has not started: ', 'Worker has not started'],
    ['Recurring Issue Risk: ', 'Recurring Issue Risk'],
    ['Weather: ', 'Weather'], ['Recurring: ', 'Recurring'],
    ['Priority: ', 'Priority'], ['Complaint ID: ', 'Complaint ID']
  ];

  function t(input) {
    const source = String(input ?? '');
    if (language === 'en') return source;
    const entries = dict[language] || {};
    if (Object.prototype.hasOwnProperty.call(entries, source)) return entries[source];
    const trimmed = source.trim();
    if (!trimmed) return source;
    const whites = source.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const prefix = whites[1], raw = whites[2], suffix = whites[3];
    if (Object.prototype.hasOwnProperty.call(entries, raw)) {
      return prefix + entries[raw] + suffix;
    }
    // Labels often appear as a text node ending in ':' before a bold value.
    if (raw.endsWith(':') && Object.prototype.hasOwnProperty.call(entries, raw.slice(0, -1))) {
      return prefix + entries[raw.slice(0, -1)] + ':' + suffix;
    }
    const emoji = raw.match(emojiStart);
    if (emoji && entries[emoji[2]]) return prefix + emoji[1] + entries[emoji[2]] + suffix;
    const icon = emoji ? emoji[1] : '';
    const phraseText = emoji ? emoji[2] : raw;
    for (const [phrase, key] of segments) {
      if (phraseText.startsWith(phrase) && Object.prototype.hasOwnProperty.call(entries, key)) {
        const suffixText = phraseText.slice(phrase.length);
        return prefix + icon + entries[key] + (suffixText ? ': ' + t(suffixText) : ':') + suffix;
      }
    }
    // Translation of short relative-time display text, leaving numerals untouched.
    const rel = raw.match(/^(\d+)([mhd]) ago$/);
    if (rel) {
      const key = rel[2] === 'm' ? 'minutes ago' : rel[2] === 'h' ? 'hours ago' : 'days ago';
      if (entries[key]) return prefix + rel[1] + ' ' + entries[key] + suffix;
    }
    return source;
  }

  function translateNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (!parent || isExcluded(parent)) return;
    if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','OPTIONAL'].includes(parent.tagName)) return;
    if (!/[A-Za-z]/.test(node.nodeValue)) {
      const state = originalText.get(node);
      if (!state) return;
    }
    let state = originalText.get(node);
    if (!state || node.nodeValue !== state.last) {
      state = { source: node.nodeValue, last: node.nodeValue };
      originalText.set(node, state);
    }
    const output = t(state.source);
    if (node.nodeValue !== output) node.nodeValue = output;
    state.last = output;
  }

  function translateAttributes(el) {
    if (!(el instanceof Element) || isExcluded(el)) return;
    let attrState = originalAttributes.get(el);
    if (!attrState) {
      attrState = {};
      originalAttributes.set(el, attrState);
    }
    for (const name of attrNames) {
      if (!el.hasAttribute(name)) continue;
      const value = el.getAttribute(name);
      let state = attrState[name];
      if (!state || value !== state.last) state = attrState[name] = { source: value, last: value };
      const output = t(state.source);
      if (output !== value) el.setAttribute(name, output);
      state.last = output;
    }
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) return translateNode(root);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let next;
    while ((next = walker.nextNode())) {
      if (next.nodeType === Node.TEXT_NODE) translateNode(next);
      else translateAttributes(next);
    }
  }

  function setLanguage(next) {
    if (!LANGUAGES[next]) return;
    language = next;
    localStorage.setItem('civic_language', next);
    document.documentElement.lang = next;
    const chooser = document.getElementById('civic-language');
    if (chooser) chooser.value = next;
    translateTree(document.body);
    document.title = t('CivicPulse — Smart Civic Engagement Platform');
    document.dispatchEvent(new CustomEvent('civic-language-changed', { detail: { language } }));
  }

  function init() {
    const select = document.getElementById('civic-language');
    if (select) {
      select.value = language;
      select.addEventListener('change', () => setLanguage(select.value));
    }
    translateTree(document.body);
    document.documentElement.lang = language;
    document.title = t('CivicPulse — Smart Civic Engagement Platform');
    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          translateNode(mutation.target);
        } else if (mutation.type === 'attributes') {
          translateAttributes(mutation.target);
        } else {
          mutation.addedNodes.forEach(translateTree);
        }
      }
    });
    observer.observe(document.body, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: attrNames
    });
  }

  window.I18n = {
    t,
    locale: () => ({en: 'en-IN', ta: 'ta-IN', hi: 'hi-IN'})[language],
    language: () => language,
    setLanguage,
    translateTree
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();