(() => {
  const state = {
    activeTab: 'shot',
    equipment: [],
    activeEquipment: { machine: null, grinder: null },
    beans: [],
    calibration: {
      totalRatings: 0,
      minRequired: 3,
      remaining: 3,
      isCalibrating: true,
      statusText: 'Kalibrierung läuft...',
      favoriteNotes: [],
    },
    latestShot: null,
    recentShots: [],
    aiStatus: { configured: false, source: null, maskedKey: null, model: 'gemini-3.8-flash' },

    shotStars: 3,
    tasteSlider: 0,
    lastAiSuggestedParams: null,

    timerRunning: false,
    timerStartMs: 0,
    timerInterval: null,

    beanFormRating: null,
    openRatingBeanId: null,
    pendingScanFullDataUrl: '',
    pendingBeanThumbDataUrl: '',
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(message, type = 'info') {
    const container = $('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s ease';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  async function api(url, options = {}) {
    if (
      state.useStandalone ||
      (window.CremaStandaloneEngine && window.CremaStandaloneEngine.isGithubPagesHost())
    ) {
      state.useStandalone = true;
      return window.CremaStandaloneEngine.request(url, options);
    }

    const opts = { ...options };
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch (netErr) {
      if (window.CremaStandaloneEngine) {
        state.useStandalone = true;
        return window.CremaStandaloneEngine.request(url, options);
      }
      throw netErr;
    }

    if (res.status === 404 && url === '/api/bootstrap' && window.CremaStandaloneEngine) {
      state.useStandalone = true;
      return window.CremaStandaloneEngine.request(url, options);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Fehler (${res.status})`);
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function handleApiError(err, customMissingKeyMsg) {
    if (err && err.code === 'MISSING_API_KEY') {
      showToast(
        customMissingKeyMsg || 'Bitte trage unter „Setup“ deinen Gemini API-Key ein.',
        'error'
      );
      switchTab('equipment');
      $('input-gemini-key').focus();
      return;
    }
    showToast(err?.message || 'Ein Fehler ist aufgetreten.', 'error');
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.view').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${tabName}`);
    });
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
  }

  // --- Header & KI Status ---
  function renderHeaderAndAiStatus() {
    const machineName = state.activeEquipment.machine?.name || 'Keine Maschine';
    const grinderName = state.activeEquipment.grinder?.name || 'Keine Mühle';
    $('header-setup-line').textContent = `${machineName} · ${grinderName}`;
    $('grind-grinder-hint').textContent = grinderName;

    const dot = $('ai-status-dot');
    const label = $('ai-status-label');
    if (state.aiStatus.configured) {
      dot.classList.add('ready');
      label.textContent = 'KI bereit';
      $('modal-key-current-status').textContent = `Aktiv (${state.aiStatus.model}) · Gespeichert: ${
        state.aiStatus.maskedKey || 'Ja'
      }`;
      const canBuildLink =
        Boolean(state.aiStatus.githubPagesUrl) ||
        window.location.hostname.endsWith('github.io');
      $('mobile-link-box').classList.toggle('hidden', !canBuildLink);
    } else {
      dot.classList.remove('ready');
      label.textContent = 'KI einrichten';
      $('modal-key-current-status').textContent = 'Aktuell ist noch kein API-Key hinterlegt.';
      $('mobile-link-box').classList.add('hidden');
    }

    if (state.aiStatus.model) {
      const sel = $('input-gemini-model');
      if ([...sel.options].some((o) => o.value === state.aiStatus.model)) {
        sel.value = state.aiStatus.model;
      }
    }
  }

  // --- Brew Ratio & Bean Selection ---
  function updateLiveShotMetrics() {
    const inG = Number($('shot-in').value);
    const outG = Number($('shot-out').value);
    $('live-ratio-text').textContent =
      inG > 0 && outG > 0 ? `1:${(outG / inG).toFixed(1)}` : '—';
  }

  function renderBeanSelectDropdown() {
    const select = $('shot-bean-select');
    const prevValue = select.value;

    $('no-beans-hint').classList.toggle('hidden', state.beans.length > 0);

    select.innerHTML = [
      '<option value="">Ohne feste Bohne</option>',
      ...state.beans.map((b) => {
        const star = b.ref_in_g !== null ? ' ★' : '';
        return `<option value="${b.id}">${escapeHtml(b.roaster)} – ${escapeHtml(b.name)}${star}</option>`;
      }),
    ].join('');

    if (prevValue && state.beans.some((b) => String(b.id) === String(prevValue))) {
      select.value = prevValue;
    } else if (
      state.latestShot?.bean_id &&
      state.beans.some((b) => b.id === state.latestShot.bean_id)
    ) {
      select.value = String(state.latestShot.bean_id);
    } else if (state.beans.length > 0 && !prevValue) {
      select.value = String(state.beans[0].id);
    }

    updateReferenceBannerForSelectedBean();
    updatePerfectRecipeButtonState();
  }

  function updateReferenceBannerForSelectedBean() {
    const beanId = Number($('shot-bean-select').value);
    const bean = state.beans.find((b) => b.id === beanId);
    const banner = $('shot-reference-banner');

    if (bean && bean.ref_in_g !== null) {
      banner.classList.remove('hidden');
      $('shot-reference-summary').textContent = `${bean.ref_in_g}g → ${bean.ref_out_g}g · ${bean.ref_time_s}s · ${bean.ref_temp_c}°C · Mahlgrad ${bean.ref_grind}`;
    } else {
      banner.classList.add('hidden');
    }
  }

  // WICHTIG: Zwingendes Vorausfüllen der exakten Parameter des vorherigen Bezugs beim Laden
  function hydrateShotMaskFromLatest(latestShot) {
    if (latestShot) {
      $('shot-in').value = latestShot.in_g;
      $('shot-out').value = latestShot.out_g;
      $('shot-time').value = latestShot.time_s;
      $('shot-temp').value = latestShot.temp_c;
      $('shot-grind').value = latestShot.grind_setting;

      if (latestShot.bean_id && state.beans.some((b) => b.id === latestShot.bean_id)) {
        $('shot-bean-select').value = String(latestShot.bean_id);
      }
      $('shot-prefill-badge').textContent = `Vom letzten Bezug (#${latestShot.id})`;
    } else {
      // Standardwerte für 18g Sieb vor dem allerersten Bezug
      $('shot-in').value = 18;
      $('shot-out').value = 36;
      $('shot-time').value = 28;
      $('shot-temp').value = 93;
      $('shot-grind').value = '15';
      $('shot-prefill-badge').textContent = '18g Sieb Startwerte';
    }

    updateLiveShotMetrics();
    updateReferenceBannerForSelectedBean();
    updatePerfectRecipeButtonState();
  }

  // --- Sterne & Sauer-Neutral-Bitter Slider ---
  function setShotStars(stars) {
    state.shotStars = Math.max(1, Math.min(5, Number(stars)));
    document.querySelectorAll('#shot-stars-group .star-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.star) <= state.shotStars);
    });
    updatePerfectRecipeButtonState();
  }

  function formatTasteSliderLabel(val) {
    const v = Number(val);
    const pct = Math.round(Math.abs(v) * 100);
    if (Math.abs(v) <= 0.12) {
      return { text: 'Neutral (Ausgewogen)', cls: '' };
    }
    if (v < 0) {
      return { text: v <= -0.5 ? `Deutlich sauer (${pct}%)` : `Etwas sauer (${pct}%)`, cls: 'sour' };
    }
    return {
      text: v >= 0.5 ? `Deutlich bitter (${pct}%)` : `Etwas bitter (${pct}%)`,
      cls: 'bitter',
    };
  }

  function setTasteSlider(val) {
    const clamped = Math.max(-1, Math.min(1, Number(val)));
    state.tasteSlider = clamped;
    $('shot-taste-slider').value = String(clamped);
    const info = formatTasteSliderLabel(clamped);
    const pill = $('taste-readout-pill');
    pill.textContent = info.text;
    pill.className = `taste-status ${info.cls}`.trim();
    updatePerfectRecipeButtonState();
  }

  function updatePerfectRecipeButtonState() {
    const isFiveStars = state.shotStars === 5;
    const isNeutral = Math.abs(state.tasteSlider) <= 0.12;
    const hasBean = Boolean($('shot-bean-select').value);

    const btn = $('btn-save-reference-recipe');
    if (isFiveStars && isNeutral && hasBean) {
      btn.disabled = false;
      btn.textContent = '★ Perfektes Rezept für diese Bohne speichern';
    } else if (isFiveStars && isNeutral && !hasBean) {
      btn.disabled = true;
      btn.textContent = '★ Rezept speichern (bitte oben Bohne wählen)';
    } else {
      btn.disabled = true;
      btn.textContent = '★ Rezept speichern (ab 5★ & Neutral)';
    }
  }

  // --- Stoppuhr ---
  function toggleShotTimer() {
    const btn = $('btn-shot-timer');
    const label = $('shot-timer-label');

    if (!state.timerRunning) {
      state.timerRunning = true;
      state.timerStartMs = performance.now();
      btn.classList.add('running');
      label.textContent = 'Stopp (0.0s)';
      state.timerInterval = setInterval(() => {
        const elapsed = ((performance.now() - state.timerStartMs) / 1000).toFixed(1);
        $('shot-time').value = elapsed;
        label.textContent = `Stopp (${elapsed}s)`;
      }, 100);
    } else {
      clearInterval(state.timerInterval);
      state.timerRunning = false;
      const finalSec = Math.max(
        1,
        Math.round(((performance.now() - state.timerStartMs) / 1000) * 2) / 2
      );
      $('shot-time').value = finalSec;
      btn.classList.remove('running');
      label.textContent = 'Stoppuhr starten';
    }
  }

  function readShotPayload() {
    const beanVal = $('shot-bean-select').value;
    return {
      bean_id: beanVal ? Number(beanVal) : null,
      basket_size: 18,
      in_g: Number($('shot-in').value),
      out_g: Number($('shot-out').value),
      time_s: Number($('shot-time').value),
      temp_c: Number($('shot-temp').value),
      grind_setting: $('shot-grind').value.trim(),
      stars: state.shotStars,
      taste_slider: state.tasteSlider,
    };
  }

  function renderAiBaristaAnalysis(analysis) {
    if (!analysis) return;
    const card = $('ai-barista-result-card');
    card.classList.remove('hidden');
    $('ai-extraction-state').textContent = analysis.extraction_state || '';
    $('ai-command-text').textContent = analysis.command || '—';
    $('ai-diagnosis-text').textContent = analysis.diagnosis || '';

    const sp = analysis.suggested_params;
    if (sp) {
      state.lastAiSuggestedParams = sp;
      $('ai-suggested-strip').classList.remove('hidden');
      $('ai-suggested-metrics').textContent = `${sp.in_g}g → ${sp.out_g}g · ${sp.time_s}s · ${sp.temp_c}°C · Mahlgrad ${sp.grind_setting}`;
    } else {
      state.lastAiSuggestedParams = null;
      $('ai-suggested-strip').classList.add('hidden');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveShot({ runAi = false } = {}) {
    if (state.timerRunning) toggleShotTimer();
    const payload = readShotPayload();
    if (
      [payload.in_g, payload.out_g, payload.time_s, payload.temp_c].some(
        (n) => Number.isNaN(n) || n <= 0
      ) ||
      !payload.grind_setting
    ) {
      showToast('Bitte gültige Werte für Dosis, Ergebnis, Zeit, Temperatur & Mahlgrad eingeben.', 'error');
      return;
    }

    const btnMain = $('btn-save-and-analyze');
    const btnOnly = $('btn-save-shot-only');
    btnMain.disabled = true;
    btnOnly.disabled = true;

    let savedShot = null;
    try {
      const saved = await api('/api/shots', { method: 'POST', body: payload });
      savedShot = saved.shot;
      state.latestShot = saved.latestShot;
      state.recentShots = saved.recentShots;
      state.beans = saved.beans;

      hydrateShotMaskFromLatest(state.latestShot);
      renderShotsHistory();
      renderBeansList();

      if (runAi) {
        btnMain.textContent = 'KI-Barista wertet aus…';
        const aiRes = await api('/api/ai/barista', {
          method: 'POST',
          body: { ...payload, shot_id: savedShot.id },
        });
        state.recentShots = aiRes.recentShots;
        renderAiBaristaAnalysis(aiRes.analysis);
        renderShotsHistory();
      } else {
        showToast('Bezug gespeichert.', 'success');
      }
    } catch (err) {
      handleApiError(
        err,
        savedShot
          ? 'Bezug gespeichert! Trage hier deinen Gemini API-Key ein, um den KI-Barista zu nutzen.'
          : undefined
      );
    } finally {
      btnMain.disabled = false;
      btnOnly.disabled = false;
      btnMain.textContent = 'Speichern & KI-Barista fragen';
    }
  }

  async function savePerfectReferenceRecipe() {
    const beanId = Number($('shot-bean-select').value);
    if (!beanId) return;
    const payload = readShotPayload();
    const btn = $('btn-save-reference-recipe');
    btn.disabled = true;

    try {
      const res = await api(`/api/beans/${beanId}/reference-recipe`, {
        method: 'PUT',
        body: payload,
      });
      state.beans = res.beans;
      updateReferenceBannerForSelectedBean();
      renderBeanSelectDropdown();
      renderBeansList();
      showToast('Als perfektes Referenzrezept gespeichert!', 'success');
    } catch (err) {
      handleApiError(err);
    } finally {
      updatePerfectRecipeButtonState();
    }
  }

  function renderShotsHistory() {
    const list = $('shots-history-list');
    $('shots-count-label').textContent = `${state.recentShots.length}`;

    if (state.recentShots.length === 0) {
      list.innerHTML = '<div class="empty-state">Noch keine Bezüge gespeichert.</div>';
      return;
    }

    list.innerHTML = state.recentShots
      .map((s) => {
        const sliderInfo = formatTasteSliderLabel(s.taste_slider);
        const beanLabel = s.bean_name
          ? `${escapeHtml(s.bean_roaster)} – ${escapeHtml(s.bean_name)}`
          : `Bezug #${s.id}`;

        return `
          <div class="history-item">
            <div class="row-split">
              <strong>${beanLabel}</strong>
              <span class="mono muted-sm">${s.stars}★ · ${escapeHtml(sliderInfo.text)}</span>
            </div>
            <div class="mono muted-sm" style="margin-top:4px;">
              ${s.in_g}g → ${s.out_g}g · ${s.time_s}s · ${s.temp_c}°C · Mahlgrad ${escapeHtml(s.grind_setting)}
            </div>
            ${
              s.ai_command
                ? `<div style="margin-top:5px;color:var(--accent);font-size:0.78rem;">→ ${escapeHtml(s.ai_command)}</div>`
                : ''
            }
            <div class="bean-sub-actions" style="margin-top:8px;">
              <button type="button" class="link-action" data-load-shot="${s.id}">Oben eintragen</button>
              <button type="button" class="muted-btn" data-delete-shot="${s.id}">Löschen</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // --- Phase 1: Kalibrierung & Bohnen ---
  function renderCalibrationStatus() {
    const cal = state.calibration;
    const dot = $('calib-dot');
    const navDot = $('nav-beans-calib-dot');
    const statusEl = $('calib-status-text');
    const counterEl = $('calib-counter-badge');
    const descEl = $('calib-desc');
    const fillEl = $('calib-progress-fill');
    const tagsEl = $('calib-learned-tags');

    if (cal.isCalibrating) {
      dot.classList.remove('ready');
      navDot.classList.remove('hidden');
      statusEl.textContent = 'Kalibrierung läuft...';
      counterEl.textContent = `${cal.totalRatings} / ${cal.minRequired}`;
      descEl.textContent = `Noch ${cal.remaining} Bewertung${
        cal.remaining === 1 ? '' : 'en'
      } (1–10) nötig, damit die KI deinen Geschmack kennt.`;
      fillEl.style.width = `${Math.min(100, Math.round((cal.totalRatings / cal.minRequired) * 100))}%`;
      tagsEl.classList.add('hidden');
      tagsEl.innerHTML = '';
    } else {
      dot.classList.add('ready');
      navDot.classList.add('hidden');
      statusEl.textContent = 'Geschmacksprofil kalibriert';
      counterEl.textContent = `${cal.totalRatings} Bewertungen`;
      descEl.textContent = 'Deine bevorzugten Geschmacksnoten fließen in alle KI-Vorschläge ein.';
      fillEl.style.width = '100%';

      if (cal.favoriteNotes && cal.favoriteNotes.length > 0) {
        tagsEl.classList.remove('hidden');
        tagsEl.innerHTML = cal.favoriteNotes
          .map((n) => `<span class="note-pill">♥ ${escapeHtml(n.label)} (Ø ${n.avgScore})</span>`)
          .join('');
      } else {
        tagsEl.classList.add('hidden');
      }
    }
  }

  function renderBeanFormRatingGrid() {
    $('bean-form-rating-grid').innerHTML = Array.from({ length: 10 }, (_, idx) => {
      const score = idx + 1;
      const active = state.beanFormRating === score ? 'active' : '';
      return `<button type="button" class="rate-btn mono ${active}" data-form-rate="${score}">${score}</button>`;
    }).join('');
    $('bean-form-rating-display').textContent = state.beanFormRating
      ? `${state.beanFormRating} von 10`
      : 'Optional';
  }

  function resetBeanForm() {
    $('bean-edit-id').value = '';
    $('bean-form-title').textContent = 'Neue Kaffeebohne';
    $('bean-roaster').value = '';
    $('bean-name').value = '';
    $('bean-roast-date').value = '';
    $('bean-expiry-date').value = '';
    $('bean-flavor-notes').value = '';
    $('bean-ai-tips').value = '';
    state.beanFormRating = null;
    state.pendingScanFullDataUrl = '';
    state.pendingBeanThumbDataUrl = '';
    $('scan-preview-box').classList.add('hidden');
    $('bean-initial-rating-wrap').classList.remove('hidden');
    renderBeanFormRatingGrid();
  }

  function openBeanFormForEdit(bean) {
    resetBeanForm();
    $('bean-edit-id').value = String(bean.id);
    $('bean-form-title').textContent = 'Bohne bearbeiten';
    $('bean-roaster').value = bean.roaster || '';
    $('bean-name').value = bean.name || '';
    $('bean-roast-date').value = bean.roast_date || '';
    $('bean-expiry-date').value = bean.expiry_date || '';
    $('bean-flavor-notes').value = bean.flavor_notes || '';
    $('bean-ai-tips').value = bean.ai_recipe_tips || '';
    state.pendingBeanThumbDataUrl = bean.image_data || '';
    $('bean-initial-rating-wrap').classList.add('hidden');
    $('bean-form-card').classList.remove('hidden');
    $('bean-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderBeansList() {
    const list = $('beans-list');
    if (state.beans.length === 0) {
      list.innerHTML =
        '<div class="empty-state">Noch keine Bohnen gespeichert. Fotografiere oben ein Etikett oder trage deine Bohne manuell ein.</div>';
      return;
    }

    list.innerHTML = state.beans
      .map((b) => {
        const notes = String(b.flavor_notes || '')
          .split(/[,;/•]+/)
          .map((n) => n.trim())
          .filter(Boolean);

        const dateParts = [];
        if (b.roast_date) dateParts.push(`Geröstet: ${b.roast_date}`);
        if (b.expiry_date) dateParts.push(`MHD: ${b.expiry_date}`);

        const scoreLabel =
          b.avg_rating !== null && b.avg_rating !== undefined
            ? `★ ${b.avg_rating} / 10`
            : '1–10 bewerten';

        const isRateOpen = state.openRatingBeanId === b.id;
        const currentRounded = b.avg_rating ? Math.round(b.avg_rating) : 0;

        return `
          <article class="card">
            <div class="row-split">
              <div class="bean-card-head">
                ${
                  b.image_data
                    ? `<img class="bean-thumb" src="${escapeHtml(b.image_data)}" alt="" />`
                    : ''
                }
                <div>
                  <h3 class="bean-title">${escapeHtml(b.name)}</h3>
                  <p class="bean-sub">
                    ${escapeHtml(b.roaster)}${
          dateParts.length ? ` · ${escapeHtml(dateParts.join(' · '))}` : ''
        }
                  </p>
                </div>
              </div>
              <button type="button" class="btn-secondary-sm mono" data-toggle-rate="${b.id}">
                ${escapeHtml(scoreLabel)}
              </button>
            </div>

            ${
              notes.length > 0
                ? `<div class="tags-row" style="margin-top:10px;">${notes
                    .map((n) => `<span class="note-pill">${escapeHtml(n)}</span>`)
                    .join('')}</div>`
                : ''
            }

            ${
              isRateOpen
                ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
                    <div class="muted-sm" style="margin-bottom:6px;">Wie gut gefällt dir diese Bohne (1–10)?</div>
                    <div class="scale-10">
                      ${Array.from({ length: 10 }, (_, i) => {
                        const s = i + 1;
                        return `<button type="button" class="rate-btn mono ${
                          currentRounded === s ? 'active' : ''
                        }" data-bean-rate="${b.id}" data-score="${s}">${s}</button>`;
                      }).join('')}
                    </div>
                  </div>`
                : ''
            }

            ${
              b.ref_in_g !== null
                ? `<div class="ref-bar">
                    <div>
                      <span class="ref-badge">★ Referenz</span>
                      <span class="mono ref-numbers">${b.ref_in_g}g → ${b.ref_out_g}g · ${b.ref_time_s}s · ${b.ref_temp_c}°C · Mahlgrad ${escapeHtml(b.ref_grind)}</span>
                    </div>
                  </div>`
                : ''
            }

            ${
              b.ai_recipe_tips
                ? `<div class="bean-recipe-box">${escapeHtml(b.ai_recipe_tips)}</div>`
                : ''
            }

            <div class="bean-footer">
              <button type="button" class="link-action" data-brew-bean="${b.id}">
                Für Bezug auswählen →
              </button>
              <div class="bean-sub-actions">
                <button type="button" class="muted-btn" data-ai-recipe-bean="${b.id}">KI-Rezept</button>
                <button type="button" class="muted-btn" data-edit-bean="${b.id}">Bearbeiten</button>
                <button type="button" class="muted-btn" data-delete-bean="${b.id}">Löschen</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  // --- Gemini 3.8 Flash Vision Scan ---
  function resizeImageFile(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Ungültiges Bildformat.'));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function processLabelImageFile(file) {
    if (!file) return;
    switchTab('beans');
    resetBeanForm();
    $('bean-form-card').classList.remove('hidden');

    try {
      const [fullDataUrl, thumbDataUrl] = await Promise.all([
        resizeImageFile(file, 1500, 0.85),
        resizeImageFile(file, 200, 0.72),
      ]);
      state.pendingScanFullDataUrl = fullDataUrl;
      state.pendingBeanThumbDataUrl = thumbDataUrl;

      $('scan-preview-img').src = thumbDataUrl;
      $('scan-preview-box').classList.remove('hidden');
      await runGeminiVisionScan();
    } catch (err) {
      handleApiError(err);
    }
  }

  async function runGeminiVisionScan() {
    if (!state.pendingScanFullDataUrl) return;
    $('scan-status-title').textContent = 'Etikett wird gelesen…';
    $('scan-status-msg').textContent = 'Gemini 3.8 Flash erkennt die Felder';
    $('btn-rescan-image').disabled = true;

    try {
      const { extracted } = await api('/api/ai/scan-label', {
        method: 'POST',
        body: { imageBase64: state.pendingScanFullDataUrl },
      });

      if (extracted.roaster) $('bean-roaster').value = extracted.roaster;
      if (extracted.name) $('bean-name').value = extracted.name;
      if (extracted.roast_date) $('bean-roast-date').value = extracted.roast_date;
      if (extracted.expiry_date) $('bean-expiry-date').value = extracted.expiry_date;
      if (extracted.flavor_notes) $('bean-flavor-notes').value = extracted.flavor_notes;

      $('scan-status-title').textContent = 'Etikett erkannt';
      $('scan-status-msg').textContent = 'Bitte kurz prüfen & speichern.';
      showToast('Etikett erfolgreich ausgelesen.', 'success');
    } catch (err) {
      $('scan-status-title').textContent = 'Auslesen pausiert';
      $('scan-status-msg').textContent = err.message || 'API-Key unter Setup prüfen.';
      handleApiError(err);
    } finally {
      $('btn-rescan-image').disabled = false;
    }
  }

  async function generateRecipeIntoBeanForm() {
    const btn = $('btn-generate-bean-recipe');
    btn.disabled = true;
    btn.textContent = 'Erstelle…';
    try {
      const payload = {
        roaster: $('bean-roaster').value.trim(),
        name: $('bean-name').value.trim(),
        roast_date: $('bean-roast-date').value,
        expiry_date: $('bean-expiry-date').value,
        flavor_notes: $('bean-flavor-notes').value.trim(),
      };
      const res = await api('/api/ai/bean-recipe', { method: 'POST', body: payload });
      if (res.recipe_tips) {
        $('bean-ai-tips').value = res.recipe_tips;
      }
    } catch (err) {
      handleApiError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Per KI vorschlagen';
    }
  }

  async function submitBeanForm(e) {
    e.preventDefault();
    const editId = $('bean-edit-id').value;
    const name = $('bean-name').value.trim();
    if (!name) {
      showToast('Bitte gib den Namen der Bohne ein.', 'error');
      $('bean-name').focus();
      return;
    }

    const body = {
      roaster: $('bean-roaster').value.trim() || 'Unbekannter Röster',
      name,
      roast_date: $('bean-roast-date').value,
      expiry_date: $('bean-expiry-date').value,
      flavor_notes: $('bean-flavor-notes').value.trim(),
      ai_recipe_tips: $('bean-ai-tips').value.trim(),
      image_data: state.pendingBeanThumbDataUrl || '',
    };

    if (!editId && state.beanFormRating) {
      body.rating = state.beanFormRating;
    }

    const btn = $('btn-submit-bean');
    btn.disabled = true;
    try {
      const res = editId
        ? await api(`/api/beans/${editId}`, { method: 'PUT', body })
        : await api('/api/beans', { method: 'POST', body });

      state.beans = res.beans;
      state.calibration = res.calibration;
      renderCalibrationStatus();
      renderBeansList();
      renderBeanSelectDropdown();

      $('bean-form-card').classList.add('hidden');
      resetBeanForm();
      showToast('Bohne gespeichert.', 'success');
    } catch (err) {
      handleApiError(err);
    } finally {
      btn.disabled = false;
    }
  }

  // --- Phase 1: Equipment ---
  function renderEquipmentLists() {
    const container = $('equipment-combined-list');
    if (state.equipment.length === 0) {
      container.innerHTML = '<div class="empty-state">Noch keine Geräte eingetragen.</div>';
      return;
    }

    container.innerHTML = state.equipment
      .map((item) => {
        const typeLabel = item.type === 'machine' ? 'Maschine' : 'Mühle';
        return `
          <div class="param-row">
            <div class="param-info">
              <span class="param-name">${escapeHtml(item.name)}</span>
              <span class="param-sub">
                ${typeLabel}${item.notes ? ` · ${escapeHtml(item.notes)}` : ''}
              </span>
              <div class="bean-sub-actions" style="margin-top:6px;">
                <button type="button" class="muted-btn" data-edit-equip="${item.id}">Bearbeiten</button>
                <button type="button" class="muted-btn" data-delete-equip="${item.id}">Entfernen</button>
              </div>
            </div>
            <div>
              ${
                item.is_default
                  ? '<span class="ref-badge">Aktiv</span>'
                  : `<button type="button" class="btn-secondary-sm" data-default-equip="${item.id}">Aktivieren</button>`
              }
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function submitEquipmentForm(e) {
    e.preventDefault();
    const editId = $('equip-edit-id').value;
    const name = $('equip-name').value.trim();
    if (!name) return;

    const body = {
      type: $('equip-type').value,
      name,
      notes: $('equip-notes').value.trim(),
      is_default: $('equip-default').checked ? 1 : 0,
    };

    try {
      const res = editId
        ? await api(`/api/equipment/${editId}`, { method: 'PUT', body })
        : await api('/api/equipment', { method: 'POST', body });

      state.equipment = res.equipment;
      state.activeEquipment = res.activeEquipment;
      renderHeaderAndAiStatus();
      renderEquipmentLists();
      $('equipment-form').classList.add('hidden');
      $('equip-edit-id').value = '';
      showToast('Gerät gespeichert.', 'success');
    } catch (err) {
      handleApiError(err);
    }
  }

  // --- Event Listeners ---
  function bindEvents() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('btn-go-setup').addEventListener('click', () => {
      switchTab('equipment');
      $('input-gemini-key').focus();
    });

    $('btn-save-ai-key').addEventListener('click', async () => {
      try {
        const keyVal = $('input-gemini-key').value.trim();
        const payload = { model: $('input-gemini-model').value };
        if (keyVal) payload.apiKey = keyVal;
        const res = await api('/api/settings/api-key', { method: 'POST', body: payload });
        state.aiStatus = res.aiStatus;
        $('input-gemini-key').value = '';
        renderHeaderAndAiStatus();
        showToast('KI-Einstellungen gespeichert.', 'success');
      } catch (err) {
        handleApiError(err);
      }
    });

    $('btn-test-ai-key').addEventListener('click', async () => {
      const btn = $('btn-test-ai-key');
      btn.disabled = true;
      btn.textContent = 'Prüfe…';
      try {
        const res = await api('/api/settings/test-ai', {
          method: 'POST',
          body: {
            apiKey: $('input-gemini-key').value.trim() || undefined,
            model: $('input-gemini-model').value,
          },
        });
        showToast(`Verbindung steht (${res.model})!`, 'success');
      } catch (err) {
        showToast(err.message || 'Verbindung fehlgeschlagen.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Verbindung testen';
      }
    });

    $('btn-copy-mobile-link').addEventListener('click', async () => {
      try {
        const res = await api('/api/settings/mobile-setup-link', { method: 'POST', body: {} });
        await navigator.clipboard.writeText(res.setupUrl);
        showToast('24/7 Handy-Startlink (inkl. Key) kopiert!', 'success');
      } catch (err) {
        handleApiError(err);
      }
    });

    const openAddBean = () => {
      switchTab('beans');
      resetBeanForm();
      $('bean-form-card').classList.remove('hidden');
      $('bean-roaster').focus();
    };
    $('btn-quick-add-bean').addEventListener('click', openAddBean);
    $('btn-first-bean').addEventListener('click', openAddBean);

    $('shot-bean-select').addEventListener('change', () => {
      updateReferenceBannerForSelectedBean();
      updatePerfectRecipeButtonState();
    });

    $('btn-apply-reference').addEventListener('click', () => {
      const beanId = Number($('shot-bean-select').value);
      const bean = state.beans.find((b) => b.id === beanId);
      if (bean && bean.ref_in_g !== null) {
        $('shot-in').value = bean.ref_in_g;
        $('shot-out').value = bean.ref_out_g;
        $('shot-time').value = bean.ref_time_s;
        $('shot-temp').value = bean.ref_temp_c;
        $('shot-grind').value = bean.ref_grind;
        updateLiveShotMetrics();
        showToast('Referenzrezept übernommen.', 'info');
      }
    });

    // 18g Sieb Schnell-Reset & 1:2 Ratio
    $('btn-reset-18g').addEventListener('click', () => {
      $('shot-in').value = 18;
      updateLiveShotMetrics();
    });

    $('btn-calc-1to2').addEventListener('click', () => {
      const inG = Number($('shot-in').value);
      if (inG > 0) {
        $('shot-out').value = Number((inG * 2).toFixed(1));
        updateLiveShotMetrics();
      }
    });

    document.querySelectorAll('[data-step-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = $(btn.dataset.stepTarget);
        const step = Number(btn.dataset.step);
        const min = Number(input.min || 0);
        const max = Number(input.max || 999);
        const current = Number(input.value || 0);
        input.value = Math.min(max, Math.max(min, Number((current + step).toFixed(2))));
        updateLiveShotMetrics();
      });
    });

    document.querySelectorAll('[data-grind-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = $('shot-grind');
        const step = Number(btn.dataset.grindStep);
        const parsed = parseFloat(input.value.replace(',', '.'));
        input.value = !Number.isNaN(parsed)
          ? String(Math.max(0, Number((parsed + step).toFixed(2))))
          : '15';
      });
    });

    ['shot-in', 'shot-out'].forEach((id) => {
      $(id).addEventListener('input', updateLiveShotMetrics);
    });

    $('btn-shot-timer').addEventListener('click', toggleShotTimer);

    document.querySelectorAll('#shot-stars-group .star-btn').forEach((btn) => {
      btn.addEventListener('click', () => setShotStars(Number(btn.dataset.star)));
    });

    $('shot-taste-slider').addEventListener('input', (e) => setTasteSlider(e.target.value));
    document.querySelectorAll('[data-slider-set]').forEach((btn) => {
      btn.addEventListener('click', () => setTasteSlider(Number(btn.dataset.sliderSet)));
    });

    $('shot-form').addEventListener('submit', (e) => {
      e.preventDefault();
      saveShot({ runAi: true });
    });
    $('btn-save-shot-only').addEventListener('click', () => saveShot({ runAi: false }));
    $('btn-save-reference-recipe').addEventListener('click', savePerfectReferenceRecipe);

    $('btn-apply-ai-suggestion').addEventListener('click', () => {
      const sp = state.lastAiSuggestedParams;
      if (!sp) return;
      $('shot-in').value = sp.in_g;
      $('shot-out').value = sp.out_g;
      $('shot-time').value = sp.time_s;
      $('shot-temp').value = sp.temp_c;
      $('shot-grind').value = sp.grind_setting;
      updateLiveShotMetrics();
      $('shot-prefill-badge').textContent = 'KI-Empfehlung eingetragen';
      showToast('Werte für den nächsten Bezug eingetragen.', 'success');
    });

    $('shots-history-list').addEventListener('click', async (e) => {
      const loadBtn = e.target.closest('[data-load-shot]');
      if (loadBtn) {
        const shot = state.recentShots.find((s) => s.id === Number(loadBtn.dataset.loadShot));
        if (shot) {
          hydrateShotMaskFromLatest(shot);
          setShotStars(shot.stars);
          setTasteSlider(shot.taste_slider);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }

      const delBtn = e.target.closest('[data-delete-shot]');
      if (delBtn) {
        try {
          const res = await api(`/api/shots/${delBtn.dataset.deleteShot}`, { method: 'DELETE' });
          state.latestShot = res.latestShot;
          state.recentShots = res.recentShots;
          state.beans = res.beans;
          hydrateShotMaskFromLatest(state.latestShot);
          renderShotsHistory();
          renderBeansList();
        } catch (err) {
          handleApiError(err);
        }
      }
    });

    $('bean-camera-input').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      processLabelImageFile(file);
    });
    $('btn-rescan-image').addEventListener('click', runGeminiVisionScan);

    $('btn-toggle-bean-form').addEventListener('click', () => {
      const form = $('bean-form-card');
      if (form.classList.contains('hidden')) {
        resetBeanForm();
        form.classList.remove('hidden');
        $('bean-roaster').focus();
      } else {
        form.classList.add('hidden');
      }
    });
    $('btn-close-bean-form').addEventListener('click', () => {
      $('bean-form-card').classList.add('hidden');
    });

    document.querySelectorAll('.chip-tag').forEach((tag) => {
      tag.addEventListener('click', () => {
        const input = $('bean-flavor-notes');
        const note = tag.dataset.flavor;
        const existing = input.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!existing.some((x) => x.toLowerCase() === note.toLowerCase())) {
          existing.push(note);
          input.value = existing.join(', ');
        }
      });
    });

    $('bean-form-rating-grid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-form-rate]');
      if (!btn) return;
      const val = Number(btn.dataset.formRate);
      state.beanFormRating = state.beanFormRating === val ? null : val;
      renderBeanFormRatingGrid();
    });

    $('btn-generate-bean-recipe').addEventListener('click', generateRecipeIntoBeanForm);
    $('bean-form-card').addEventListener('submit', submitBeanForm);

    $('beans-list').addEventListener('click', async (e) => {
      const toggleRate = e.target.closest('[data-toggle-rate]');
      if (toggleRate) {
        const id = Number(toggleRate.dataset.toggleRate);
        state.openRatingBeanId = state.openRatingBeanId === id ? null : id;
        renderBeansList();
        return;
      }

      const rateBtn = e.target.closest('[data-bean-rate]');
      if (rateBtn) {
        const beanId = Number(rateBtn.dataset.beanRate);
        const score = Number(rateBtn.dataset.score);
        try {
          const res = await api(`/api/beans/${beanId}/rate`, {
            method: 'POST',
            body: { score },
          });
          state.beans = res.beans;
          state.calibration = res.calibration;
          state.openRatingBeanId = null;
          renderCalibrationStatus();
          renderBeansList();
          showToast(`Mit ${score}/10 bewertet.`, 'success');
        } catch (err) {
          handleApiError(err);
        }
        return;
      }

      const brewBtn = e.target.closest('[data-brew-bean]');
      if (brewBtn) {
        $('shot-bean-select').value = String(brewBtn.dataset.brewBean);
        updateReferenceBannerForSelectedBean();
        updatePerfectRecipeButtonState();
        switchTab('shot');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      const aiRecipeBtn = e.target.closest('[data-ai-recipe-bean]');
      if (aiRecipeBtn) {
        const bean = state.beans.find((b) => b.id === Number(aiRecipeBtn.dataset.aiRecipeBean));
        if (!bean) return;
        aiRecipeBtn.textContent = 'Erstelle…';
        try {
          await api('/api/ai/bean-recipe', {
            method: 'POST',
            body: { ...bean, bean_id: bean.id, auto_save: true },
          });
          const refreshed = await api('/api/beans');
          state.beans = refreshed.beans;
          renderBeansList();
          showToast('Grundrezept erstellt.', 'success');
        } catch (err) {
          handleApiError(err);
        }
        return;
      }

      const editBtn = e.target.closest('[data-edit-bean]');
      if (editBtn) {
        const bean = state.beans.find((b) => b.id === Number(editBtn.dataset.editBean));
        if (bean) openBeanFormForEdit(bean);
        return;
      }

      const delBtn = e.target.closest('[data-delete-bean]');
      if (delBtn) {
        try {
          const res = await api(`/api/beans/${delBtn.dataset.deleteBean}`, { method: 'DELETE' });
          state.beans = res.beans;
          state.calibration = res.calibration;
          renderCalibrationStatus();
          renderBeansList();
          renderBeanSelectDropdown();
        } catch (err) {
          handleApiError(err);
        }
      }
    });

    $('btn-toggle-equip-form').addEventListener('click', () => {
      $('equip-edit-id').value = '';
      $('equip-name').value = '';
      $('equip-notes').value = '';
      $('equip-default').checked = true;
      $('equipment-form').classList.toggle('hidden');
    });
    $('btn-cancel-equip').addEventListener('click', () => {
      $('equipment-form').classList.add('hidden');
    });
    $('equipment-form').addEventListener('submit', submitEquipmentForm);

    $('equipment-combined-list').addEventListener('click', async (e) => {
      const defBtn = e.target.closest('[data-default-equip]');
      if (defBtn) {
        try {
          const res = await api(`/api/equipment/${defBtn.dataset.defaultEquip}/default`, {
            method: 'POST',
          });
          state.equipment = res.equipment;
          state.activeEquipment = res.activeEquipment;
          renderHeaderAndAiStatus();
          renderEquipmentLists();
        } catch (err) {
          handleApiError(err);
        }
        return;
      }

      const editBtn = e.target.closest('[data-edit-equip]');
      if (editBtn) {
        const item = state.equipment.find((x) => x.id === Number(editBtn.dataset.editEquip));
        if (!item) return;
        $('equip-edit-id').value = String(item.id);
        $('equip-type').value = item.type;
        $('equip-name').value = item.name;
        $('equip-notes').value = item.notes;
        $('equip-default').checked = Boolean(item.is_default);
        $('equipment-form').classList.remove('hidden');
        return;
      }

      const delBtn = e.target.closest('[data-delete-equip]');
      if (delBtn) {
        try {
          const res = await api(`/api/equipment/${delBtn.dataset.deleteEquip}`, {
            method: 'DELETE',
          });
          state.equipment = res.equipment;
          state.activeEquipment = res.activeEquipment;
          renderHeaderAndAiStatus();
          renderEquipmentLists();
        } catch (err) {
          handleApiError(err);
        }
      }
    });
  }

  async function init() {
    bindEvents();
    setShotStars(3);
    setTasteSlider(0);
    renderBeanFormRatingGrid();

    try {
      const data = await api('/api/bootstrap');
      state.equipment = data.equipment || [];
      state.activeEquipment = data.activeEquipment || { machine: null, grinder: null };
      state.beans = data.beans || [];
      state.calibration = data.calibration || state.calibration;
      state.latestShot = data.latestShot || null;
      state.recentShots = data.recentShots || [];
      state.aiStatus = data.aiStatus || state.aiStatus;

      renderHeaderAndAiStatus();
      renderEquipmentLists();
      renderCalibrationStatus();
      renderBeansList();
      renderBeanSelectDropdown();
      hydrateShotMaskFromLatest(state.latestShot);
      renderShotsHistory();
    } catch (err) {
      handleApiError(err);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
