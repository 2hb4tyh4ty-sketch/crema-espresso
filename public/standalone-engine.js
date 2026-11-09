/**
 * Standalone 24/7 Engine für GitHub Pages (ohne laufenden PC/Server).
 * Speichert Geräte, Bohnen, Bewertungen und Bezüge dauerhaft im Browser (localStorage)
 * und kommuniziert direkt per HTTPS mit der Google Gemini API (inkl. Schnell-Failover & Timeout-Schutz).
 */
(() => {
  const STORAGE_KEY = 'crema_app_db_v1';
  const DEFAULT_MODEL = 'gemini-3.8-flash';
  const LIVE_FAST_MODELS = [
    'gemini-3.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
  ];

  let lastWorkingModel = null;

  // One-Tap Hash-Import (#setupKey=...) für mühelose Einrichtung auf dem Smartphone
  try {
    if (window.location.hash && window.location.hash.includes('setupKey=')) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const importedKey = (params.get('setupKey') || '').trim();
      if (importedKey) {
        const current = loadStore();
        current.settings.gemini_api_key = importedKey;
        saveStore(current);
      }
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } catch {
    // ignore hash parse issues
  }

  function createInitialStore() {
    return {
      nextIds: { equipment: 3, beans: 1, ratings: 1, shots: 1 },
      settings: {
        gemini_api_key: '',
        gemini_model: DEFAULT_MODEL,
      },
      equipment: [
        {
          id: 1,
          type: 'machine',
          name: 'Bezzera Luce S PID',
          brand: 'Bezzera',
          model: 'Luce S PID',
          notes: 'E61 Brühgruppe mit PID-Temperaturregelung, 18g Sieb',
          is_default: 1,
        },
        {
          id: 2,
          type: 'grinder',
          name: 'DF54',
          brand: 'DF / Turin',
          model: 'DF54',
          notes: '54mm Flat Burrs Single-Dose Mühle, stufenlos',
          is_default: 1,
        },
      ],
      beans: [],
      bean_ratings: [],
      shots: [],
    };
  }

  function recomputeNextIds(store) {
    const maxId = (arr) =>
      Array.isArray(arr) && arr.length > 0
        ? arr.reduce((m, item) => Math.max(m, Number(item?.id) || 0), 0)
        : 0;
    store.nextIds = {
      equipment: Math.max(Number(store.nextIds?.equipment) || 1, maxId(store.equipment) + 1),
      beans: Math.max(Number(store.nextIds?.beans) || 1, maxId(store.beans) + 1),
      ratings: Math.max(Number(store.nextIds?.ratings) || 1, maxId(store.bean_ratings) + 1),
      shots: Math.max(Number(store.nextIds?.shots) || 1, maxId(store.shots) + 1),
    };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const init = createInitialStore();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(init));
        return init;
      }
      const parsed = JSON.parse(raw);
      if (!parsed.equipment || parsed.equipment.length === 0) {
        parsed.equipment = createInitialStore().equipment;
      }
      if (!Array.isArray(parsed.beans)) parsed.beans = [];
      if (!Array.isArray(parsed.bean_ratings)) parsed.bean_ratings = [];
      if (!Array.isArray(parsed.shots)) parsed.shots = [];
      if (!parsed.settings) {
        parsed.settings = { gemini_api_key: '', gemini_model: DEFAULT_MODEL };
      }
      if (!parsed.settings.gemini_model || parsed.settings.gemini_model.startsWith('gemini-2.')) {
        parsed.settings.gemini_model = DEFAULT_MODEL;
      }
      recomputeNextIds(parsed);
      return parsed;
    } catch {
      return createInitialStore();
    }
  }

  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function getActiveEquipment(store) {
    const machine =
      store.equipment.find((e) => e.type === 'machine' && e.is_default === 1) ||
      store.equipment.find((e) => e.type === 'machine') ||
      null;
    const grinder =
      store.equipment.find((e) => e.type === 'grinder' && e.is_default === 1) ||
      store.equipment.find((e) => e.type === 'grinder') ||
      null;
    return { machine, grinder };
  }

  function enrichBean(store, bean) {
    if (!bean) return null;
    const ratings = store.bean_ratings
      .filter((r) => r.bean_id === bean.id)
      .sort((a, b) => b.id - a.id);
    const avg =
      ratings.length > 0
        ? Number((ratings.reduce((acc, r) => acc + r.score, 0) / ratings.length).toFixed(1))
        : bean.rating ?? null;
    const shotCount = store.shots.filter((s) => s.bean_id === bean.id).length;
    return {
      ...bean,
      rating_count: ratings.length,
      avg_rating: avg,
      shot_count: shotCount,
      ratings: ratings.slice(0, 10),
    };
  }

  function listBeans(store) {
    return [...store.beans]
      .sort((a, b) => b.id - a.id)
      .map((b) => enrichBean(store, b));
  }

  function getCalibrationStatus(store) {
    const totalRatings = store.bean_ratings.length;
    const minRequired = 3;
    const isCalibrating = totalRatings < minRequired;
    const remaining = Math.max(0, minRequired - totalRatings);

    const noteWeights = new Map();
    const dislikedNotes = new Set();
    const ratedBeansDesc = [...store.bean_ratings].sort((a, b) => b.id - a.id);

    for (const r of ratedBeansDesc) {
      const bean = store.beans.find((b) => b.id === r.bean_id);
      if (!bean) continue;
      const notes = String(bean.flavor_notes || '')
        .split(/[,;/•]+/)
        .map((n) => n.trim())
        .filter(Boolean);
      for (const note of notes) {
        const key = note.toLowerCase();
        const prev = noteWeights.get(key) || { label: note, totalScore: 0, count: 0 };
        prev.totalScore += r.score;
        prev.count += 1;
        noteWeights.set(key, prev);
        if (r.score <= 4) {
          dislikedNotes.add(note);
        }
      }
    }

    const favoriteNotes = Array.from(noteWeights.values())
      .map((x) => ({
        label: x.label,
        avgScore: Number((x.totalScore / x.count).toFixed(1)),
        count: x.count,
      }))
      .filter((x) => x.avgScore >= 6.5)
      .sort((a, b) => b.avgScore - a.avgScore || b.count - a.count)
      .slice(0, 5);

    const topBeans = ratedBeansDesc
      .filter((r) => r.score >= 7)
      .slice(0, 3)
      .map((r) => {
        const b = store.beans.find((x) => x.id === r.bean_id);
        return b ? `${b.roaster} ${b.name} (${r.score}/10)` : null;
      })
      .filter(Boolean);

    return {
      totalRatings,
      minRequired,
      remaining,
      isCalibrating,
      statusText: isCalibrating ? 'Kalibrierung läuft...' : 'Präferenz-Profil aktiv',
      favoriteNotes,
      dislikedNotes: Array.from(dislikedNotes).slice(0, 4),
      topBeans,
      summaryForAi: isCalibrating
        ? 'Nutzerpräferenzen befinden sich noch in der Kalibrierung (< 3 Bohnen-Bewertungen).'
        : `Kalibriertes Geschmacksprofil (${totalRatings} Bewertungen): Bevorzugte Noten: ${
            favoriteNotes.map((n) => `${n.label} (Ø ${n.avgScore}/10)`).join(', ') || 'ausgewogen'
          }. Top-Bohnen: ${topBeans.join(', ') || 'k.A.'}.${
            dislikedNotes.size > 0
              ? ` Weniger bevorzugt: ${Array.from(dislikedNotes).join(', ')}.`
              : ''
          }`,
    };
  }

  function enrichShot(store, shot) {
    if (!shot) return null;
    const bean = store.beans.find((b) => b.id === shot.bean_id);
    const machine = store.equipment.find((e) => e.id === shot.machine_id);
    const grinder = store.equipment.find((e) => e.id === shot.grinder_id);
    return {
      ...shot,
      bean_roaster: bean?.roaster || null,
      bean_name: bean?.name || null,
      bean_flavor_notes: bean?.flavor_notes || null,
      machine_name: machine?.name || null,
      grinder_name: grinder?.name || null,
    };
  }

  function listShots(store, { beanId = null, limit = 25 } = {}) {
    const filtered = beanId
      ? store.shots.filter((s) => s.bean_id === Number(beanId))
      : store.shots;
    return [...filtered]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((s) => enrichShot(store, s));
  }

  function buildAiStatus(store) {
    const key = (store.settings.gemini_api_key || '').trim();
    const model = store.settings.gemini_model || DEFAULT_MODEL;
    const maskedKey =
      key.length >= 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : key ? '••••••••' : null;
    return {
      configured: Boolean(key),
      source: key ? 'browser' : null,
      maskedKey,
      model,
    };
  }

  function buildCandidateChain(preferredModel) {
    const ordered = [];
    const add = (m) => {
      if (m && !ordered.includes(m)) ordered.push(m);
    };

    if (lastWorkingModel) {
      add(lastWorkingModel);
    }

    // Wenn der Standardwert 'gemini-3.8-flash' aktiv ist, zuerst die schnellen
    // antwortenden Gemini-3-Flash-Endpunkte nutzen, damit kein Timeout entsteht.
    if (!preferredModel || preferredModel === 'gemini-3.8-flash') {
      LIVE_FAST_MODELS.forEach(add);
    } else {
      add(preferredModel);
      LIVE_FAST_MODELS.forEach(add);
    }
    return ordered;
  }

  // --- Direct Browser HTTPS Gemini Call with Fast Failover & Timeout ---
  async function callGeminiDirect(
    store,
    { contents, responseSchema, overrideKey, overrideModel, timeoutMs = 7000 }
  ) {
    const apiKey = (overrideKey || store.settings.gemini_api_key || '').trim();
    if (!apiKey) {
      const err = new Error(
        'Kein Gemini API-Key hinterlegt. Bitte unter „Setup“ deinen Gemini API-Key eintragen.'
      );
      err.code = 'MISSING_API_KEY';
      err.status = 400;
      throw err;
    }

    const preferred = overrideModel || store.settings.gemini_model || DEFAULT_MODEL;
    const candidates = buildCandidateChain(preferred);

    let lastErr = null;
    for (const model of candidates) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent`;

      const body = {
        contents: Array.isArray(contents)
          ? contents
          : [{ role: 'user', parts: [{ text: String(contents) }] }],
      };

      const generationConfig = {};
      if (responseSchema) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = responseSchema;
      }
      // Reduziert Denk-Latenz bei Gemini 3 Flash von ~8s auf ~1.5-2s
      if (model === 'gemini-3-flash-preview') {
        generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
      } else if (model === 'gemini-3.6-flash') {
        generationConfig.thinkingConfig = { thinkingLevel: 'low' };
      }
      if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig;
      }

      const canAbort = typeof AbortController !== 'undefined';
      const controller = canAbort ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
          ...(controller ? { signal: controller.signal } : {}),
        });

        if (res.ok) {
          const json = await res.json();
          const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          lastWorkingModel = model;
          return { text, usedModel: model };
        }

        const errData = await res.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `HTTP ${res.status}`;
        lastErr = new Error(errMsg);
        lastErr.status = res.status;

        if (
          (res.status === 400 || res.status === 403) &&
          (errMsg.toLowerCase().includes('api key') || errMsg.includes('API_KEY_INVALID'))
        ) {
          const invalid = new Error('Der eingegebene Gemini API-Key ist ungültig.');
          invalid.status = 400;
          throw invalid;
        }

        if (![503, 429, 404, 500, 504].includes(res.status)) {
          throw lastErr;
        }
      } catch (fetchErr) {
        if (fetchErr?.status === 400 && fetchErr.message.includes('API-Key')) {
          throw fetchErr;
        }
        const isTimeout = fetchErr?.name === 'AbortError';
        lastErr = isTimeout
          ? new Error(`Zeitüberschreitung bei Modell ${model}`)
          : fetchErr;
        if (lastWorkingModel === model) {
          lastWorkingModel = null;
        }
        // Bei Timeout oder Netzwerkfehler zum nächsten Modell im Failover wechseln
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    throw new Error(
      lastErr?.message ||
        'Die Gemini-Server sind momentan ausgelastet. Bitte kurz erneut versuchen.'
    );
  }

  function describeSlider(val) {
    const v = Number(val || 0);
    const pct = Math.round(Math.abs(v) * 100);
    if (v <= -0.6) return `Stark sauer (${v.toFixed(2)}, ${pct}% links Richtung Sauer)`;
    if (v <= -0.25) return `Deutlich sauer (${v.toFixed(2)}, ${pct}% Richtung Sauer)`;
    if (v < -0.1) return `Leicht sauer / spritzig (${v.toFixed(2)}, ${pct}% Richtung Sauer)`;
    if (v <= 0.1) return `Neutral / Ausgewogen (${v.toFixed(2)}, Mitte)`;
    if (v < 0.25) return `Leicht bitter / kräftig (${v.toFixed(2)}, ${pct}% Richtung Bitter)`;
    if (v < 0.6) return `Deutlich bitter (${v.toFixed(2)}, ${pct}% Richtung Bitter)`;
    return `Stark bitter / adstringierend (${v.toFixed(2)}, ${pct}% rechts Richtung Bitter)`;
  }

  function computeRoastAgeText(roastDate) {
    if (!roastDate) return 'Unbekannt';
    const parsed = new Date(`${roastDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return roastDate;
    const now = new Date();
    const diffDays = Math.floor((now - parsed) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return `Röstdatum in der Zukunft (${roastDate})`;
    return `${diffDays} Tage nach Röstung (geröstet am ${roastDate})`;
  }

  function buildBootstrapPayload(store) {
    const shots = listShots(store, { limit: 25 });
    return {
      equipment: store.equipment,
      activeEquipment: getActiveEquipment(store),
      beans: listBeans(store),
      calibration: getCalibrationStatus(store),
      latestShot: shots[0] || null,
      recentShots: shots,
      aiStatus: buildAiStatus(store),
    };
  }

  // --- Route Handler for Standalone Mode ---
  async function handleStandaloneRequest(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const body =
      typeof options.body === 'string'
        ? JSON.parse(options.body)
        : options.body || {};
    const store = loadStore();

    if (url === '/api/bootstrap' && method === 'GET') {
      return buildBootstrapPayload(store);
    }

    // Backup Export & Import (Punkt 1)
    if (url === '/api/backup' && method === 'GET') {
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        data: {
          equipment: store.equipment,
          beans: store.beans,
          bean_ratings: store.bean_ratings,
          shots: store.shots,
        },
      };
    }

    if (url === '/api/backup' && method === 'POST') {
      const incoming = body.data && typeof body.data === 'object' ? body.data : body;
      if (
        !incoming ||
        (!Array.isArray(incoming.beans) &&
          !Array.isArray(incoming.shots) &&
          !Array.isArray(incoming.equipment))
      ) {
        throw new Error('Ungültige Backup-Datei. Keine Bohnen-, Bezugs- oder Gerätedaten gefunden.');
      }

      if (Array.isArray(incoming.equipment) && incoming.equipment.length > 0) {
        store.equipment = incoming.equipment;
      }
      if (Array.isArray(incoming.beans)) {
        store.beans = incoming.beans;
      }
      if (Array.isArray(incoming.bean_ratings)) {
        store.bean_ratings = incoming.bean_ratings;
      }
      if (Array.isArray(incoming.shots)) {
        store.shots = incoming.shots;
      }

      recomputeNextIds(store);
      saveStore(store);
      return {
        ok: true,
        ...buildBootstrapPayload(store),
      };
    }

    if (url === '/api/settings/api-key' && method === 'POST') {
      if (body.apiKey !== undefined) {
        store.settings.gemini_api_key = String(body.apiKey).trim();
      }
      if (body.model) {
        store.settings.gemini_model = String(body.model).trim();
      }
      saveStore(store);
      return { ok: true, aiStatus: buildAiStatus(store) };
    }

    if (url === '/api/settings/test-ai' && method === 'POST') {
      const { text, usedModel } = await callGeminiDirect(store, {
        contents: 'Antworte nur mit dem Wort: BEREIT',
        overrideKey: body.apiKey,
        overrideModel: body.model,
        timeoutMs: 6000,
      });
      return { ok: true, model: usedModel, reply: text.trim() };
    }

    if (url === '/api/settings/mobile-setup-link' && method === 'POST') {
      const key = (store.settings.gemini_api_key || '').trim();
      if (!key) throw new Error('Bitte zuerst einen Gemini API-Key speichern.');
      const base = `${window.location.origin}${window.location.pathname}`.replace(/\/+$/, '');
      return { setupUrl: `${base}/#setupKey=${encodeURIComponent(key)}` };
    }

    // Equipment
    if (url === '/api/equipment' && method === 'POST') {
      if (body.is_default) {
        store.equipment.forEach((e) => {
          if (e.type === body.type) e.is_default = 0;
        });
      }
      const item = {
        id: store.nextIds.equipment++,
        type: body.type,
        name: String(body.name || '').trim(),
        brand: '',
        model: '',
        notes: String(body.notes || '').trim(),
        is_default: body.is_default ? 1 : 0,
      };
      store.equipment.push(item);
      saveStore(store);
      return {
        item,
        equipment: store.equipment,
        activeEquipment: getActiveEquipment(store),
      };
    }

    const equipDefaultMatch = url.match(/^\/api\/equipment\/(\d+)\/default$/);
    if (equipDefaultMatch && method === 'POST') {
      const id = Number(equipDefaultMatch[1]);
      const target = store.equipment.find((e) => e.id === id);
      if (target) {
        store.equipment.forEach((e) => {
          if (e.type === target.type) e.is_default = e.id === id ? 1 : 0;
        });
        saveStore(store);
      }
      return { equipment: store.equipment, activeEquipment: getActiveEquipment(store) };
    }

    const equipIdMatch = url.match(/^\/api\/equipment\/(\d+)$/);
    if (equipIdMatch && method === 'PUT') {
      const id = Number(equipIdMatch[1]);
      const target = store.equipment.find((e) => e.id === id);
      if (target) {
        if (body.is_default) {
          store.equipment.forEach((e) => {
            if (e.type === (body.type || target.type)) e.is_default = 0;
          });
        }
        target.type = body.type || target.type;
        target.name = body.name !== undefined ? String(body.name).trim() : target.name;
        target.notes = body.notes !== undefined ? String(body.notes).trim() : target.notes;
        target.is_default = body.is_default ? 1 : target.is_default;
        saveStore(store);
      }
      return { equipment: store.equipment, activeEquipment: getActiveEquipment(store) };
    }

    if (equipIdMatch && method === 'DELETE') {
      const id = Number(equipIdMatch[1]);
      const target = store.equipment.find((e) => e.id === id);
      store.equipment = store.equipment.filter((e) => e.id !== id);
      if (target && target.is_default === 1) {
        const fallback = store.equipment.find((e) => e.type === target.type);
        if (fallback) fallback.is_default = 1;
      }
      saveStore(store);
      return { ok: true, equipment: store.equipment, activeEquipment: getActiveEquipment(store) };
    }

    // Beans
    if (url === '/api/beans' && method === 'GET') {
      return { beans: listBeans(store), calibration: getCalibrationStatus(store) };
    }

    if (url === '/api/beans' && method === 'POST') {
      const bean = {
        id: store.nextIds.beans++,
        roaster: String(body.roaster || 'Unbekannter Röster').trim(),
        name: String(body.name || '').trim(),
        roast_date: String(body.roast_date || ''),
        expiry_date: String(body.expiry_date || ''),
        flavor_notes: String(body.flavor_notes || '').trim(),
        roast_level: String(body.roast_level || '').trim(),
        origin: String(body.origin || '').trim(),
        ai_recipe_tips: String(body.ai_recipe_tips || '').trim(),
        rating: body.rating ? Number(body.rating) : null,
        image_data: String(body.image_data || ''),
        ref_in_g: null,
        ref_out_g: null,
        ref_time_s: null,
        ref_temp_c: null,
        ref_grind: null,
      };
      store.beans.push(bean);
      if (body.rating) {
        store.bean_ratings.push({
          id: store.nextIds.ratings++,
          bean_id: bean.id,
          score: Number(body.rating),
          created_at: new Date().toISOString(),
        });
      }
      saveStore(store);
      return {
        bean: enrichBean(store, bean),
        beans: listBeans(store),
        calibration: getCalibrationStatus(store),
      };
    }

    const beanRateMatch = url.match(/^\/api\/beans\/(\d+)\/rate$/);
    if (beanRateMatch && method === 'POST') {
      const beanId = Number(beanRateMatch[1]);
      store.bean_ratings.push({
        id: store.nextIds.ratings++,
        bean_id: beanId,
        score: Math.max(1, Math.min(10, Math.round(Number(body.score)))),
        created_at: new Date().toISOString(),
      });
      saveStore(store);
      return {
        beans: listBeans(store),
        calibration: getCalibrationStatus(store),
      };
    }

    const beanRefMatch = url.match(/^\/api\/beans\/(\d+)\/reference-recipe$/);
    if (beanRefMatch && method === 'PUT') {
      const beanId = Number(beanRefMatch[1]);
      const bean = store.beans.find((b) => b.id === beanId);
      if (!bean) throw new Error('Bohne nicht gefunden.');
      if (Number(body.stars) !== 5 || Math.abs(Number(body.taste_slider)) > 0.12) {
        throw new Error('Nur bei 5 Sternen und neutralem Slider speicherbar.');
      }
      bean.ref_in_g = Number(body.in_g);
      bean.ref_out_g = Number(body.out_g);
      bean.ref_time_s = Number(body.time_s);
      bean.ref_temp_c = Number(body.temp_c);
      bean.ref_grind = String(body.grind_setting).trim();
      saveStore(store);
      return { bean: enrichBean(store, bean), beans: listBeans(store) };
    }

    const beanIdMatch = url.match(/^\/api\/beans\/(\d+)$/);
    if (beanIdMatch && method === 'PUT') {
      const beanId = Number(beanIdMatch[1]);
      const bean = store.beans.find((b) => b.id === beanId);
      if (bean) {
        [
          'roaster',
          'name',
          'roast_date',
          'expiry_date',
          'flavor_notes',
          'roast_level',
          'origin',
          'ai_recipe_tips',
          'image_data',
        ].forEach((k) => {
          if (body[k] !== undefined) bean[k] = String(body[k]);
        });
        saveStore(store);
      }
      return {
        bean: enrichBean(store, bean),
        beans: listBeans(store),
        calibration: getCalibrationStatus(store),
      };
    }

    if (beanIdMatch && method === 'DELETE') {
      const beanId = Number(beanIdMatch[1]);
      store.beans = store.beans.filter((b) => b.id !== beanId);
      store.bean_ratings = store.bean_ratings.filter((r) => r.bean_id !== beanId);
      saveStore(store);
      return { ok: true, beans: listBeans(store), calibration: getCalibrationStatus(store) };
    }

    // Shots
    if (url === '/api/shots' && method === 'POST') {
      const active = getActiveEquipment(store);
      const shot = {
        id: store.nextIds.shots++,
        bean_id: body.bean_id ? Number(body.bean_id) : null,
        machine_id: active.machine?.id || null,
        grinder_id: active.grinder?.id || null,
        basket_size: 18,
        in_g: Number(body.in_g),
        out_g: Number(body.out_g),
        time_s: Number(body.time_s),
        temp_c: Number(body.temp_c),
        grind_setting: String(body.grind_setting).trim(),
        stars: Number(body.stars || 3),
        taste_slider: Number(body.taste_slider ?? 0),
        ai_diagnosis: '',
        ai_command: '',
        ai_suggested: null,
        created_at: new Date().toISOString(),
      };
      store.shots.push(shot);
      saveStore(store);
      const recentShots = listShots(store, { limit: 25 });
      return {
        shot: enrichShot(store, shot),
        latestShot: recentShots[0] || null,
        recentShots,
        beans: listBeans(store),
      };
    }

    const shotDelMatch = url.match(/^\/api\/shots\/(\d+)$/);
    if (shotDelMatch && method === 'DELETE') {
      const id = Number(shotDelMatch[1]);
      store.shots = store.shots.filter((s) => s.id !== id);
      saveStore(store);
      const recentShots = listShots(store, { limit: 25 });
      return {
        ok: true,
        latestShot: recentShots[0] || null,
        recentShots,
        beans: listBeans(store),
      };
    }

    // AI: Vision Scan (mit erweitertem Schema analog zum Backend)
    if (url === '/api/ai/scan-label' && method === 'POST') {
      const raw = String(body.imageBase64 || '');
      const match = raw.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match ? match[1] : 'image/jpeg';
      const data = match ? match[2] : raw;
      const todayIso = new Date().toISOString().slice(0, 10);

      const { text } = await callGeminiDirect(store, {
        timeoutMs: 15000,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Analysiere dieses Foto eines Kaffee-Etiketts / einer Kaffeeverpackung sehr sorgfältig (Heutiges Datum: ${todayIso}).
Extrahiere alle erkennbaren Informationen in die JSON-Felder:
- roaster: Name der Rösterei / Marke (z. B. "19grams", "The Barn", "Elbgold").
- name: Name des Kaffees / Espresso-Blends / Single Origins.
- roast_date: Röstdatum im Format YYYY-MM-DD, falls angegeben (sonst "").
- expiry_date: Mindesthaltbarkeitsdatum (MHD / Best Before) im Format YYYY-MM-DD, falls angegeben (sonst "").
- flavor_notes: Geschmacksnoten auf Deutsch als kommagetrennte Liste (z. B. "Schokoladig, Nussig, Karamell").
- roast_level: Röstgrad ("Hell", "Mittel" oder "Dunkel"), falls erkennbar, sonst "".
- origin: Herkunftsland / Region, falls erkennbar, sonst "".
- summary_hint: Kurzer Hinweis auf Deutsch (1 Satz), welche Felder erkannt wurden.`,
              },
              { inlineData: { mimeType, data } },
            ],
          },
        ],
        responseSchema: {
          type: 'OBJECT',
          properties: {
            roaster: { type: 'STRING' },
            name: { type: 'STRING' },
            roast_date: { type: 'STRING' },
            expiry_date: { type: 'STRING' },
            flavor_notes: { type: 'STRING' },
            roast_level: { type: 'STRING' },
            origin: { type: 'STRING' },
            summary_hint: { type: 'STRING' },
          },
          required: [
            'roaster',
            'name',
            'roast_date',
            'expiry_date',
            'flavor_notes',
            'roast_level',
            'origin',
            'summary_hint',
          ],
        },
      });
      return { extracted: JSON.parse(text || '{}') };
    }

    // AI: Bean Base Recipe (Punkt 4: voller Kontext inkl. Röstalter in Tagen & Gerätenotizen)
    if (url === '/api/ai/bean-recipe' && method === 'POST') {
      const active = getActiveEquipment(store);
      const cal = getCalibrationStatus(store);
      const machineDesc = active.machine
        ? `${active.machine.name}${active.machine.notes ? ` (${active.machine.notes})` : ''}`
        : 'Bezzera Luce S PID (18g Sieb)';
      const grinderDesc = active.grinder
        ? `${active.grinder.name}${active.grinder.notes ? ` (${active.grinder.notes})` : ''}`
        : 'DF54';
      const roastAge = computeRoastAgeText(body.roast_date);

      const prompt = `Du bist ein erfahrener Specialty-Coffee Head-Barista. Erstelle ein präzises, praxisnahes Espresso-Grundrezept und Zubereitungstipps auf Deutsch für folgende Bohne und folgendes Equipment:

Equipment des Nutzers:
- Maschine: ${machineDesc}
- Mühle: ${grinderDesc}
- Siebgröße: 18g Sieb

Bohnendaten:
- Röster: ${body.roaster || 'Unbekannt'}
- Name: ${body.name || 'Unbekannt'}
- Röstdatum / Alter: ${roastAge}
- Ablaufdatum (MHD): ${body.expiry_date || 'k.A.'}
- Geschmacksnoten: ${body.flavor_notes || 'k.A.'}

Nutzer-Geschmacksprofil:
- ${cal.summaryForAi}

Formuliere in "recipe_tips" ein kurzes, übersichtliches Startrezept für das 18g Sieb:
1. Dosis & Zielmenge: 18g In -> empfohlene Gramm Out (inkl. Ratio, z. B. 1:2.0 = 36g).
2. Ziel-Bezugszeit in Sekunden & empfohlene PID-Temperatur in °C.
3. Mahlgrad-Orientierung an der ${active.grinder ? active.grinder.name : 'DF54'}.
4. 1–2 knappe Tipps zu Röstalter und Geschmacksnoten.`;

      const { text } = await callGeminiDirect(store, {
        contents: prompt,
        timeoutMs: 8000,
        responseSchema: {
          type: 'OBJECT',
          properties: {
            recipe_tips: { type: 'STRING' },
            recommended_temp_c: { type: 'NUMBER' },
            recommended_ratio: { type: 'NUMBER' },
            recommended_time_s: { type: 'NUMBER' },
          },
          required: ['recipe_tips', 'recommended_temp_c', 'recommended_ratio', 'recommended_time_s'],
        },
      });
      const parsed = JSON.parse(text || '{}');
      if (body.bean_id && body.auto_save && parsed.recipe_tips) {
        const bean = store.beans.find((b) => b.id === Number(body.bean_id));
        if (bean) {
          bean.ai_recipe_tips = parsed.recipe_tips;
          saveStore(store);
        }
      }
      return parsed;
    }

    // AI: Barista Analysis (Punkt 4: voller Kontext inkl. Historie der letzten 3 Shots, Referenzrezept, Röstalter & Flussrate)
    if (url === '/api/ai/barista' && method === 'POST') {
      const active = getActiveEquipment(store);
      const cal = getCalibrationStatus(store);
      const beanId = body.bean_id ? Number(body.bean_id) : null;
      const bean = beanId ? store.beans.find((b) => b.id === beanId) : null;

      const currentShotId = body.shot_id ? Number(body.shot_id) : null;
      const priorShots = (beanId
        ? store.shots.filter((s) => s.bean_id === beanId && s.id !== currentShotId)
        : store.shots.filter((s) => s.id !== currentShotId)
      )
        .sort((a, b) => b.id - a.id)
        .slice(0, 3);

      const inG = Number(body.in_g);
      const outG = Number(body.out_g);
      const timeS = Number(body.time_s);
      const tempC = Number(body.temp_c);
      const grind = String(body.grind_setting || '').trim();
      const stars = Number(body.stars || 3);
      const slider = Number(body.taste_slider ?? 0);
      const ratio = inG > 0 ? (outG / inG).toFixed(2) : '2.00';
      const flow = timeS > 0 ? (outG / timeS).toFixed(2) : '0.00';

      const historyLines = priorShots.length
        ? priorShots
            .map(
              (s, idx) =>
                `  #${idx + 1}: ${s.in_g}g In -> ${s.out_g}g Out in ${s.time_s}s @ ${s.temp_c}°C, Mahlgrad ${s.grind_setting} | ${s.stars}/5★, Slider ${s.taste_slider}`
            )
            .join('\n')
        : '  Keine vorherigen Bezüge gespeichert.';

      const refLine =
        bean && bean.ref_in_g !== null && bean.ref_in_g !== undefined
          ? `Gespeichertes perfektes Referenzrezept dieser Bohne: ${bean.ref_in_g}g In -> ${bean.ref_out_g}g Out in ${bean.ref_time_s}s @ ${bean.ref_temp_c}°C, Mahlgrad ${bean.ref_grind}.`
          : 'Noch kein Referenzrezept für diese Bohne gespeichert.';

      const prompt = `Du bist ein präziser KI-Chef-Barista für Espresso-Dial-In (18g Sieb). Analysiere den aktuellen Espresso-Bezug und gib GENAU EINEN klaren, sofort umsetzbaren Hauptbefehl für den nächsten Shot aus.

Equipment:
- Maschine: ${active.machine ? active.machine.name : 'Bezzera Luce S PID'} (18g Sieb)
- Mühle: ${active.grinder ? active.grinder.name : 'DF54'}

Bohne:
- ${bean ? `${bean.roaster} – ${bean.name}` : 'Nicht ausgewählt'}
- Röstalter: ${bean ? computeRoastAgeText(bean.roast_date) : 'k.A.'}
- Geschmacksnoten: ${bean && bean.flavor_notes ? bean.flavor_notes : 'k.A.'}
- ${refLine}

Aktueller Bezug (Ist-Werte):
- Dosis (In): ${inG} g (18g Sieb)
- Ergebnis (Out): ${outG} g (Brew Ratio 1:${ratio})
- Bezugszeit: ${timeS} s (Ø Flussrate ${flow} g/s)
- PID-Temperatur: ${tempC} °C
- Mahlgrad: ${grind}
- Gesamtbewertung: ${stars} von 5 Sternen
- Geschmacks-Schieberegler (Sauer -1.0 <-> Neutral 0.0 <-> Bitter +1.0): ${describeSlider(slider)}

Vorherige Bezüge zum Vergleich:
${historyLines}

Nutzer-Präferenzen:
- ${cal.summaryForAi}

Wichtige Barista-Regeln für deine Antwort:
1. "command": Gib einen kurzen, konkreten Imperativ-Befehl auf Deutsch aus (max. 14 Wörter), z. B. "Mahlgrad um 0.5 Stufen feiner stellen (auf 14.5)" oder "Ergebnis (Out) um 2g auf 38g erhöhen" oder "PID-Temperatur um 1°C auf 92°C senken". Wenn der Shot bereits perfekt ist (5 Sterne & Slider neutral um 0), lobe den Bezug und empfiehl, ihn mit "Rezept speichern" als Referenzwert zu sichern.
2. Verändere für den nächsten Shot primär EINE Stellschraube (Mahlgrad ODER Out ODER Temperatur).
3. "suggested_params": Liefere die exakten empfohlenen Parameter für den nächsten Bezug (in_g, out_g, time_s, temp_c, grind_setting), passend zu deinem Befehl.`;

      const { text } = await callGeminiDirect(store, {
        contents: prompt,
        timeoutMs: 7500,
        responseSchema: {
          type: 'OBJECT',
          properties: {
            command: { type: 'STRING' },
            extraction_state: { type: 'STRING' },
            diagnosis: { type: 'STRING' },
            suggested_params: {
              type: 'OBJECT',
              properties: {
                in_g: { type: 'NUMBER' },
                out_g: { type: 'NUMBER' },
                time_s: { type: 'NUMBER' },
                temp_c: { type: 'NUMBER' },
                grind_setting: { type: 'STRING' },
              },
              required: ['in_g', 'out_g', 'time_s', 'temp_c', 'grind_setting'],
            },
          },
          required: ['command', 'extraction_state', 'diagnosis', 'suggested_params'],
        },
      });

      const analysis = JSON.parse(text || '{}');
      if (body.shot_id) {
        const s = store.shots.find((x) => x.id === Number(body.shot_id));
        if (s) {
          s.ai_command = analysis.command || '';
          s.ai_diagnosis = analysis.diagnosis || '';
          s.ai_suggested = analysis.suggested_params || null;
          saveStore(store);
        }
      }
      return {
        analysis,
        recentShots: listShots(store, { limit: 25 }),
      };
    }

    throw new Error(`Unbekannter Endpunkt: ${url}`);
  }

  window.CremaStandaloneEngine = {
    isGithubPagesHost: () => window.location.hostname.endsWith('github.io'),
    request: handleStandaloneRequest,
  };
})();
