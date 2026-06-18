/**
 * ============================================================
 * TRACKER.JS – Script de Monitoramento de Navegação
 * Inclua este script nas páginas de conteúdo autorizado.
 * Ele envia sinais de "página ativa" ao servidor sem expor
 * nenhuma informação sensível, apenas para fins de analytics.
 * ============================================================
 */

(function () {
  'use strict';

  // ── Configuração ──────────────────────────────────────────
  const TRACKER_ENDPOINT = '/admin/api/track'; // Endpoint de tracking (futuro)
  const HEARTBEAT_MS     = 30_000;             // Sinal de "ainda aqui" a cada 30s
  const TRACK_CLICKS     = true;               // Rastrear cliques
  const TRACK_SCROLL     = true;               // Rastrear profundidade de scroll

  // ── Dados da sessão ───────────────────────────────────────
  const sessionData = {
    sessionId:  generateId(),
    pageUrl:    location.pathname + location.search,
    referrer:   document.referrer || 'direto',
    startTime:  Date.now(),
    maxScroll:  0,
    clicks:     0,
    events:     [],
  };

  // ── Geração de ID de sessão ───────────────────────────────
  function generateId() {
    return 'ss_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
  }

  // ── Envio de eventos ──────────────────────────────────────
  /**
   * Envia um evento para o servidor usando Beacon API (não bloqueia)
   * @param {string} type - Tipo do evento
   * @param {object} payload - Dados adicionais
   */
  function sendEvent(type, payload = {}) {
    const data = {
      sessionId: sessionData.sessionId,
      type,
      ts:        Date.now(),
      url:       sessionData.pageUrl,
      ...payload,
    };

    // Usa sendBeacon para garantir entrega mesmo no unload
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        TRACKER_ENDPOINT,
        new Blob([JSON.stringify(data)], { type: 'application/json' })
      );
    } else {
      // Fallback com fetch keepalive
      fetch(TRACKER_ENDPOINT, {
        method:      'POST',
        body:        JSON.stringify(data),
        headers:     { 'Content-Type': 'application/json' },
        keepalive:   true,
        credentials: 'same-origin',
      }).catch(() => { /* silencioso */ });
    }
  }

  // ── Rastreamento de Scroll ─────────────────────────────────
  if (TRACK_SCROLL) {
    let scrollThrottle = null;
    window.addEventListener('scroll', () => {
      if (scrollThrottle) return;
      scrollThrottle = setTimeout(() => {
        const scrolled = Math.round(
          (window.scrollY / (document.documentElement.scrollHeight - window.innerHeight || 1)) * 100
        );
        if (scrolled > sessionData.maxScroll) {
          sessionData.maxScroll = scrolled;
          sessionData.events.push({ type: 'scroll', depth: scrolled, ts: Date.now() });
        }
        scrollThrottle = null;
      }, 250);
    }, { passive: true });
  }

  // ── Rastreamento de Cliques ────────────────────────────────
  if (TRACK_CLICKS) {
    document.addEventListener('click', e => {
      sessionData.clicks++;
      const target = e.target.closest('a, button, [data-track]');
      if (target) {
        sessionData.events.push({
          type:  'click',
          tag:   target.tagName.toLowerCase(),
          text:  (target.innerText || target.value || '').slice(0, 50),
          href:  target.href || null,
          ts:    Date.now(),
        });
      }
    }, { passive: true });
  }

  // ── Evento de página vista ─────────────────────────────────
  sendEvent('pageview', {
    referrer:   sessionData.referrer,
    screenW:    screen.width,
    screenH:    screen.height,
    lang:       navigator.language,
    tz:         Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // ── Heartbeat periódico ───────────────────────────────────
  const heartbeatInterval = setInterval(() => {
    sendEvent('heartbeat', {
      timeOnPage:  Math.round((Date.now() - sessionData.startTime) / 1000),
      maxScroll:   sessionData.maxScroll,
      clicks:      sessionData.clicks,
    });
  }, HEARTBEAT_MS);

  // ── Evento de saída da página ─────────────────────────────
  function onPageExit() {
    clearInterval(heartbeatInterval);
    sendEvent('pageleave', {
      timeOnPage: Math.round((Date.now() - sessionData.startTime) / 1000),
      maxScroll:  sessionData.maxScroll,
      clicks:     sessionData.clicks,
      events:     sessionData.events.slice(-20), // últimos 20 eventos
    });
  }

  // Captura tanto visibilitychange quanto beforeunload para cobertura máxima
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onPageExit();
  });
  window.addEventListener('beforeunload', onPageExit);
  window.addEventListener('pagehide',     onPageExit);

  // ── API Pública (opcional para uso em páginas) ────────────
  window.__tracker = {
    /**
     * Registra um evento customizado
     * @param {string} name - Nome do evento
     * @param {object} data - Dados do evento
     */
    track: (name, data = {}) => sendEvent('custom:' + name, data),
    sessionId: sessionData.sessionId,
  };

  console.debug('[Tracker] Iniciado. SessionID:', sessionData.sessionId);
})();
