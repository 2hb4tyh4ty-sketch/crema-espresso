const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadEngineInSandbox(initialHash = '') {
  const storageMap = new Map();
  let currentHash = initialHash;

  const sandbox = {
    window: {
      location: {
        hostname: 'demo.github.io',
        pathname: '/crema/',
        search: '',
        get hash() {
          return currentHash;
        },
      },
      history: {
        replaceState: (_s, _t, newUrl) => {
          currentHash = '';
          sandbox.window.lastReplacedUrl = newUrl;
        },
      },
    },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
    },
    URLSearchParams,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    command: 'Mahlgrad um 0.5 Stufen feiner stellen',
                    extraction_state: 'Unterextrahiert',
                    diagnosis: 'Zu schnell gelaufen.',
                    suggested_params: {
                      in_g: 18,
                      out_g: 36,
                      time_s: 28,
                      temp_c: 93,
                      grind_setting: '14.5',
                    },
                  }),
                },
              ],
            },
          },
        ],
      }),
    }),
  };

  const code = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'standalone-engine.js'),
    'utf8'
  );
  vm.runInNewContext(code, sandbox);
  return sandbox.window.CremaStandaloneEngine;
}

test('GitHub Pages Standalone Engine: Geräte, Kalibrierung, 18g Shots & Referenzrezept', async () => {
  const engine = loadEngineInSandbox('#setupKey=AIzaSyTest1234567890');
  assert.equal(engine.isGithubPagesHost(), true);

  const boot1 = await engine.request('/api/bootstrap', { method: 'GET' });
  assert.equal(boot1.aiStatus.configured, true);
  assert.equal(boot1.aiStatus.model, 'gemini-3.8-flash');
  assert.equal(boot1.activeEquipment.machine.name, 'Bezzera Luce S PID');
  assert.equal(boot1.activeEquipment.grinder.name, 'DF54');
  assert.equal(boot1.calibration.statusText, 'Kalibrierung läuft...');

  // Bohne + 3 Bewertungen
  const created = await engine.request('/api/beans', {
    method: 'POST',
    body: { roaster: '19grams', name: 'Wild at Heart', flavor_notes: 'Schokoladig, Nussig', rating: 9 },
  });
  assert.equal(created.calibration.totalRatings, 1);
  assert.equal(created.calibration.statusText, 'Kalibrierung läuft...');

  await engine.request(`/api/beans/${created.bean.id}/rate`, { method: 'POST', body: { score: 8 } });
  const r3 = await engine.request(`/api/beans/${created.bean.id}/rate`, {
    method: 'POST',
    body: { score: 9 },
  });
  assert.equal(r3.calibration.totalRatings, 3);
  assert.equal(r3.calibration.isCalibrating, false);

  // Shot speichern & exaktes Vorausfüllen prüfen
  await engine.request('/api/shots', {
    method: 'POST',
    body: {
      bean_id: created.bean.id,
      in_g: 18.2,
      out_g: 36.8,
      time_s: 27.5,
      temp_c: 93.5,
      grind_setting: '14.5',
      stars: 5,
      taste_slider: 0,
    },
  });

  const boot2 = await engine.request('/api/bootstrap', { method: 'GET' });
  assert.equal(boot2.latestShot.in_g, 18.2);
  assert.equal(boot2.latestShot.out_g, 36.8);
  assert.equal(boot2.latestShot.grind_setting, '14.5');

  // Referenzrezept speichern (5★ + Neutral)
  const ref = await engine.request(`/api/beans/${created.bean.id}/reference-recipe`, {
    method: 'PUT',
    body: {
      in_g: 18.2,
      out_g: 36.8,
      time_s: 27.5,
      temp_c: 93.5,
      grind_setting: '14.5',
      stars: 5,
      taste_slider: 0,
    },
  });
  assert.equal(ref.bean.ref_in_g, 18.2);

  // KI-Barista Aufruf
  const ai = await engine.request('/api/ai/barista', {
    method: 'POST',
    body: {
      bean_id: created.bean.id,
      in_g: 18.2,
      out_g: 36.8,
      time_s: 22,
      temp_c: 93.5,
      grind_setting: '15',
      stars: 3,
      taste_slider: -0.5,
    },
  });
  assert.match(ai.analysis.command, /feiner/);
});
