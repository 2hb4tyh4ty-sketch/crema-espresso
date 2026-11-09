const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');

function startTestServer(aiOverrides = {}) {
  const mockAiService = {
    resolveAiConfig: () => ({
      configured: true,
      source: 'test',
      maskedKey: 'AIza••••TEST',
      model: 'gemini-3.8-flash',
    }),
    testApiKey: async () => ({ ok: true, model: 'gemini-3.8-flash', reply: 'BEREIT' }),
    scanCoffeeLabel: async () => ({
      roaster: '19grams',
      name: 'Wild at Heart',
      roast_date: '2026-10-20',
      expiry_date: '2027-10-20',
      flavor_notes: 'Schokoladig, Nussig, Karamell',
      roast_level: 'Mittel',
      origin: 'Brasilien & Peru',
      summary_hint: 'Etikett erfolgreich erkannt.',
    }),
    generateBeanRecipe: async (_repo, bean) => ({
      recipe_tips: `Grundrezept für ${bean.name} (18g Sieb): 18g In -> 36g Out in 28s bei 93°C auf der Bezzera Luce S PID, DF54 Mahlgrad 14.5.`,
      recommended_temp_c: 93,
      recommended_ratio: 2.0,
      recommended_time_s: 28,
    }),
    analyzeShotBarista: async (_repo, shot) => ({
      command:
        shot.taste_slider < -0.12
          ? 'Mahlgrad an der DF54 um 0.5 Stufen feiner stellen'
          : shot.taste_slider > 0.12
          ? 'Yield um 2g reduzieren oder 0.5 Stufen gröber mahlen'
          : 'Rezept beibehalten und als Referenz speichern',
      extraction_state: shot.taste_slider < -0.12 ? 'Unterextrahiert' : 'Ausgewogen',
      diagnosis: 'Analyse basierend auf Bezugszeit, Brew Ratio und Geschmacks-Slider.',
      suggested_params: {
        in_g: Number(shot.in_g),
        out_g: Number(shot.out_g),
        time_s: 28,
        temp_c: Number(shot.temp_c),
        grind_setting: '14.0',
      },
    }),
    ...aiOverrides,
  };

  const { app, repo } = createApp({ dbPath: ':memory:', aiService: mockAiService });
  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        repo,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function reqJson(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('Phase 1: Initiale Standardgeräte (Bezzera Luce S PID & DF54) sind angelegt', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const { status, data } = await reqJson(srv.baseUrl, '/api/bootstrap');
  assert.equal(status, 200);
  assert.equal(data.equipment.length, 2);
  assert.equal(data.activeEquipment.machine.name, 'Bezzera Luce S PID');
  assert.equal(data.activeEquipment.grinder.name, 'DF54');

  // Weiteres Gerät hinzufügen & aktivieren
  const addRes = await reqJson(srv.baseUrl, '/api/equipment', {
    method: 'POST',
    body: {
      type: 'grinder',
      name: 'Niche Zero',
      brand: 'Niche',
      model: 'Zero',
      is_default: 1,
    },
  });
  assert.equal(addRes.status, 201);
  assert.equal(addRes.data.activeEquipment.grinder.name, 'Niche Zero');
});

test('Phase 1: Gemini Vision Etikettenscan, Bohnen-CRUD, Grundrezept & 1-10 Kalibrierung (< 3 Bewertungen)', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  // 1. Etikett auslesen per Vision API
  const scanRes = await reqJson(srv.baseUrl, '/api/ai/scan-label', {
    method: 'POST',
    body: { imageBase64: 'data:image/jpeg;base64,dGVzdGltYWdl' },
  });
  assert.equal(scanRes.status, 200);
  assert.equal(scanRes.data.extracted.roaster, '19grams');
  assert.equal(scanRes.data.extracted.flavor_notes, 'Schokoladig, Nussig, Karamell');

  // 2. Bohne anlegen (noch ohne Bewertung -> 0 Bewertungen -> "Kalibrierung läuft...")
  const createRes = await reqJson(srv.baseUrl, '/api/beans', {
    method: 'POST',
    body: {
      ...scanRes.data.extracted,
      roast_date: '2026-10-22', // angepasstes Röstdatum
    },
  });
  assert.equal(createRes.status, 201);
  const beanId = createRes.data.bean.id;
  assert.equal(createRes.data.bean.roast_date, '2026-10-22');
  assert.equal(createRes.data.calibration.totalRatings, 0);
  assert.equal(createRes.data.calibration.isCalibrating, true);
  assert.equal(createRes.data.calibration.statusText, 'Kalibrierung läuft...');

  // 3. KI-Grundrezept generieren & automatisch speichern
  const recipeRes = await reqJson(srv.baseUrl, '/api/ai/bean-recipe', {
    method: 'POST',
    body: { ...createRes.data.bean, bean_id: beanId, auto_save: true },
  });
  assert.equal(recipeRes.status, 200);
  assert.match(recipeRes.data.recipe_tips, /Bezzera Luce S PID/);
  assert.match(recipeRes.data.bean.ai_recipe_tips, /18g In/);

  // 4. Bewertungen 1 und 2 (< 3) -> weiterhin "Kalibrierung läuft..."
  const rate1 = await reqJson(srv.baseUrl, `/api/beans/${beanId}/rate`, {
    method: 'POST',
    body: { score: 9 },
  });
  assert.equal(rate1.data.calibration.totalRatings, 1);
  assert.equal(rate1.data.calibration.statusText, 'Kalibrierung läuft...');

  const rate2 = await reqJson(srv.baseUrl, `/api/beans/${beanId}/rate`, {
    method: 'POST',
    body: { score: 8 },
  });
  assert.equal(rate2.data.calibration.totalRatings, 2);
  assert.equal(rate2.data.calibration.isCalibrating, true);
  assert.equal(rate2.data.calibration.statusText, 'Kalibrierung läuft...');

  // 5. Bewertung 3 (>= 3) -> Kalibrierung abgeschlossen!
  const rate3 = await reqJson(srv.baseUrl, `/api/beans/${beanId}/rate`, {
    method: 'POST',
    body: { score: 9 },
  });
  assert.equal(rate3.data.calibration.totalRatings, 3);
  assert.equal(rate3.data.calibration.isCalibrating, false);
  assert.notEqual(rate3.data.calibration.statusText, 'Kalibrierung läuft...');
  assert.ok(rate3.data.calibration.favoriteNotes.length > 0);
});

test('Phase 2: Exaktes Vorausfüllen des vorherigen Bezugs, KI-Barista & perfektes Referenzrezept speichern', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  // Bohne anlegen
  const beanRes = await reqJson(srv.baseUrl, '/api/beans', {
    method: 'POST',
    body: { roaster: 'Elbgold', name: 'Nueve', flavor_notes: 'Schokoladig, Haselnuss' },
  });
  const beanId = beanRes.data.bean.id;

  // Erster Bezug (16g Sieb, zu sauer)
  const shot1 = await reqJson(srv.baseUrl, '/api/shots', {
    method: 'POST',
    body: {
      bean_id: beanId,
      basket_size: 16,
      in_g: 16.2,
      out_g: 33.4,
      time_s: 23.5,
      temp_c: 92.5,
      grind_setting: '15.5',
      stars: 3,
      taste_slider: -0.55,
    },
  });
  assert.equal(shot1.status, 201);

  // KI-Barista Analyse für sauren Bezug
  const aiRes = await reqJson(srv.baseUrl, '/api/ai/barista', {
    method: 'POST',
    body: {
      shot_id: shot1.data.shot.id,
      bean_id: beanId,
      in_g: 16.2,
      out_g: 33.4,
      time_s: 23.5,
      temp_c: 92.5,
      grind_setting: '15.5',
      stars: 3,
      taste_slider: -0.55,
    },
  });
  assert.equal(aiRes.status, 200);
  assert.match(aiRes.data.analysis.command, /feiner/);

  // Zweiter Bezug (20g Sieb, exakte krumme Parameter testen)
  const shot2 = await reqJson(srv.baseUrl, '/api/shots', {
    method: 'POST',
    body: {
      bean_id: beanId,
      basket_size: 20,
      in_g: 20.1,
      out_g: 40.8,
      time_s: 28.5,
      temp_c: 93.5,
      grind_setting: '14.25',
      stars: 5,
      taste_slider: 0,
    },
  });
  assert.equal(shot2.status, 201);

  // WICHTIG: Beim erneuten Laden (/api/bootstrap) müssen exakt die Parameter von Shot #2 geliefert werden
  const boot = await reqJson(srv.baseUrl, '/api/bootstrap');
  assert.equal(boot.data.latestShot.in_g, 20.1);
  assert.equal(boot.data.latestShot.out_g, 40.8);
  assert.equal(boot.data.latestShot.time_s, 28.5);
  assert.equal(boot.data.latestShot.temp_c, 93.5);
  assert.equal(boot.data.latestShot.grind_setting, '14.25');

  // "Rezept speichern" darf bei nicht-perfektem Bezug (z. B. 4 Sterne oder saurer Slider) NICHT akzeptiert werden
  const badRef = await reqJson(srv.baseUrl, `/api/beans/${beanId}/reference-recipe`, {
    method: 'PUT',
    body: {
      in_g: 20.1,
      out_g: 40.8,
      time_s: 28.5,
      temp_c: 93.5,
      grind_setting: '14.25',
      stars: 4,
      taste_slider: 0,
    },
  });
  assert.equal(badRef.status, 400);

  // "Rezept speichern" bei perfektem Bezug (5 Sterne + Neutraler Slider = 0) MUSS als Referenzwert gespeichert werden
  const goodRef = await reqJson(srv.baseUrl, `/api/beans/${beanId}/reference-recipe`, {
    method: 'PUT',
    body: {
      in_g: 20.1,
      out_g: 40.8,
      time_s: 28.5,
      temp_c: 93.5,
      grind_setting: '14.25',
      stars: 5,
      taste_slider: 0.02,
    },
  });
  assert.equal(goodRef.status, 200);
  assert.equal(goodRef.data.bean.ref_in_g, 20.1);
  assert.equal(goodRef.data.bean.ref_out_g, 40.8);
  assert.equal(goodRef.data.bean.ref_time_s, 28.5);
  assert.equal(goodRef.data.bean.ref_temp_c, 93.5);
  assert.equal(goodRef.data.bean.ref_grind, '14.25');

  // Backup Export & Import testen
  const backupRes = await reqJson(srv.baseUrl, '/api/backup');
  assert.equal(backupRes.status, 200);
  assert.equal(backupRes.data.data.beans.length, 1);
  assert.equal(backupRes.data.data.shots.length, 2);

  await reqJson(srv.baseUrl, `/api/beans/${beanId}`, { method: 'DELETE' });
  const restoreRes = await reqJson(srv.baseUrl, '/api/backup', {
    method: 'POST',
    body: backupRes.data,
  });
  assert.equal(restoreRes.status, 200);
  assert.equal(restoreRes.data.beans.length, 1);
  assert.equal(restoreRes.data.beans[0].ref_in_g, 20.1);
});
