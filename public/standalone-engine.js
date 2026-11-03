/**
 * Standalone 24/7 Engine für GitHub Pages (ohne laufenden PC/Server).
 * Speichert Geräte, Bohnen, Bewertungen und Bezüge dauerhaft im Browser (localStorage)
 * und kommuniziert direkt per HTTPS mit der Google Gemini API (inkl. 3.8-Flash Auto-Failover).
 */
(() => {
  const STORAGE_KEY = 'crema_app_db_v1';
  const DEFAULT_MODEL = 'gemini-3.8-flash';
  const FALLBACK_MODELS = [
    'gemini-3.8-flash',
    'gemini-3-flash-preview',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
  ];

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
      if (!parsed.settings) {
        parsed.settings = { gemini_api_key: '', gemini_model: DEFAULT_MODEL };
      }
      if (!parsed.settings.gemini_model || parsed.settings.gemini_model.startsWith('gemini-2.')) {
        parsed.settings.gemini_model = DEFAULT_MODEL;
      }
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
    for (const r of store.bean_ratings) {
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
      }
    }

    const favoriteNotes = Array.from(noteWeights.values())
      .map((x) => ({
        label: x.label,
        avgScore: Number((x.totalScore / x.count).toFixed(1)),
        count: x.count,
      }))
      .filter((x) => x.avgScore >= 6.5)
      .sort((a, b) => b.avgScore - a.avgScore)
      .slice(0, 5);

    return {
      totalRatings,
      minRequired,
      remaining,
      isCalibrating,
      statusText: isCalibrating ? 'Kalibrierung läuft...' : 'Präferenz-Profil aktiv',
      favoriteNotes,
      summaryForAi: isCalibrating
        ? 'Nutzerpräferenzen befinden sich noch in der Kalibrierung (< 3 Bohnen-Bewertungen).'
        : `Kalibriertes Geschmacksprofil (${totalRatings} Bewertungen): Bevorzugte Noten: ${
            favoriteNotes.map((n) => `${n.label} (Ø ${n.avgScore}/10)`).join(', ') || 'ausgewogen'
          }.`,
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
      machine_name: machine?.name || null,
      grinder_name: grinder?.name || null,
    };
  }

  function listShots(store, limit = 25) {
    return [...store.shots]
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

  // --- Direct Browser HTTPS Gemini Call with 3.8-Flash Failover ---
  async function callGeminiDirect(store, { contents, responseSchema, overrideKey, overrideModel }) {
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
    const candidates = [preferred, ...FALLBACK_MODELS.filter((m) => m !== preferred)];

    let lastErr = null;
    for (const model of candidates) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const body = {
        contents: Array.isArray(contents)
          ? contents
          : [{ role: 'user', parts: [{ text: String(contents) }] }],
      };

      if (responseSchema) {
        body.generationConfig = {
          responseMimeType: 'application/json',
          responseSchema,
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { text, usedModel: model };
      }

      const errData = await res.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${res.status}`;
      lastErr = new Error(errMsg);
      lastErr.status = res.status;

      if (res.status === 400 && errMsg.toLowerCase().includes('api key')) {
        const invalid = new Error('Der eingegebene Gemini API-Key ist ungültig.');
        invalid.status = 400;
        throw invalid;
      }

      if (![503, 429, 404].includes(res.status)) {
        throw lastErr;
      }
    }

    throw new Error(
      lastErr?.message || 'Die Gemini-Server sind momentan ausgelastet. Bitte kurz erneut versuchen.'
    );
  }

  function describeSlider(val) {
    const v = Number(val || 0);
    const pct = Math.round(Math.abs(v) * 100);
    if (v <= -0.5) return `Deutlich sauer (${v.toFixed(2)}, ${pct}% Richtung Sauer)`;
    if (v < -0.12) return `Leicht sauer (${v.toFixed(2)}, ${pct}% Richtung Sauer)`;
    if (v <= 0.12) return `Neutral / Ausgewogen (${v.toFixed(2)}, Mitte)`;
    if (v < 0.5) return `Leicht bitter (${v.toFixed(2)}, ${pct}% Richtung Bitter)`;
    return `Deutlich bitter (${v.toFixed(2)}, ${pct}% Richtung Bitter)`;
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
      const shots = listShots(store, 25);
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
      store.equipment = store.equipment.filter((e) => e.id !== id);
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
        ['roaster', 'name', 'roast_date', 'expiry_date', 'flavor_notes', 'ai_recipe_tips', 'image_data'].forEach(
          (k) => {
            if (body[k] !== undefined) bean[k] = String(body[k]);
          }
        );
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
        created_at: new Date().toISOString(),
      };
      store.shots.push(shot);
      saveStore(store);
      const recentShots = listShots(store, 25);
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
      const recentShots = listShots(store, 25);
      return {
        ok: true,
        latestShot: recentShots[0] || null,
        recentShots,
        beans: listBeans(store),
      };
    }

    // AI: Vision Scan
    if (url === '/api/ai/scan-label' && method === 'POST') {
      const raw = String(body.imageBase64 || '');
      const match = raw.match(/^data:([^;]+);base64,(.+)$/);
      const mimeType = match ? match[1] : 'image/jpeg';
      const data = match ? match[2] : raw;
      const todayIso = new Date().toISOString().slice(0, 10);

      const { text } = await callGeminiDirect(store, {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Analysiere dieses Kaffee-Etikett (Heute: ${todayIso}). Extrahiere JSON: roaster, name, roast_date (YYYY-MM-DD oder ""), expiry_date (YYYY-MM-DD oder ""), flavor_notes (auf Deutsch, kommagetrennt).`,
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
          },
          required: ['roaster', 'name', 'roast_date', 'expiry_date', 'flavor_notes'],
        },
      });
      return { extracted: JSON.parse(text || '{}') };
    }

    // AI: Bean Base Recipe
    if (url === '/api/ai/bean-recipe' && method === 'POST') {
      const active = getActiveEquipment(store);
      const cal = getCalibrationStatus(store);
      const prompt = `Erstelle ein kurzes deutsches Espresso-Grundrezept für 18g Sieb (${
        active.machine?.name || 'Bezzera Luce S PID'
      }, Mühle ${active.grinder?.name || 'DF54'}):
Bohne: ${body.roaster || ''} ${body.name || ''}, Röstdatum: ${body.roast_date || 'k.A.'}, Noten: ${
        body.flavor_notes || 'k.A.'
      }.
${cal.summaryForAi}
Gib 18g In -> Ziel-Out (g), Zeit (s), PID-Temperatur (°C), DF54 Mahlgrad-Startwert und 1 kurzen Tipp an.`;

      const { text } = await callGeminiDirect(store, {
        contents: prompt,
        responseSchema: {
          type: 'OBJECT',
          properties: {
            recipe_tips: { type: 'STRING' },
          },
          required: ['recipe_tips'],
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

    // AI: Barista Analysis
    if (url === '/api/ai/barista' && method === 'POST') {
      const active = getActiveEquipment(store);
      const cal = getCalibrationStatus(store);
      const bean = store.beans.find((b) => b.id === Number(body.bean_id));
      const ratio = body.in_g > 0 ? (body.out_g / body.in_g).toFixed(2) : '2.0';

      const prompt = `Du bist ein KI-Barista (${active.machine?.name || 'Bezzera Luce S PID'} mit 18g Sieb, ${
        active.grinder?.name || 'DF54'
      }).
Bohne: ${bean ? `${bean.roaster} – ${bean.name} (${bean.flavor_notes})` : 'k.A.'}
Bezug: ${body.in_g}g In -> ${body.out_g}g Out (1:${ratio}) in ${body.time_s}s bei ${body.temp_c}°C, Mahlgrad ${
        body.grind_setting
      }.
Bewertung: ${body.stars}/5 Sterne, Geschmack: ${describeSlider(body.taste_slider)}.
${cal.summaryForAi}
Gib genau EINEN kurzen konkreten Befehl für den nächsten Shot auf Deutsch (z.B. "Mahlgrad um 0.5 Stufen feiner stellen"), eine kurze Begründung und suggested_params aus.`;

      const { text } = await callGeminiDirect(store, {
        contents: prompt,
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
          saveStore(store);
        }
      }
      return {
        analysis,
        recentShots: listShots(store, 25),
      };
    }

    throw new Error(`Unbekannter Endpunkt: ${url}`);
  }

  window.CremaStandaloneEngine = {
    isGithubPagesHost: () => window.location.hostname.endsWith('github.io'),
    request: handleStandaloneRequest,
  };
})();
