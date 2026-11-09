const { GoogleGenAI, Type } = require('@google/genai');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const FALLBACK_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
];

let lastWorkingModel = null;

function resolveAiConfig(repo) {
  const dbKey = repo.getSetting('gemini_api_key');
  const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const apiKey = (dbKey || envKey || '').trim();
  const source = dbKey ? 'app' : envKey ? 'env' : null;
  const rawModel = (repo.getSetting('gemini_model') || process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const model = rawModel.startsWith('gemini-2.') ? DEFAULT_MODEL : rawModel;

  let maskedKey = null;
  if (apiKey.length >= 8) {
    maskedKey = `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
  } else if (apiKey.length > 0) {
    maskedKey = '••••••••';
  }

  return {
    apiKey,
    configured: Boolean(apiKey),
    source,
    maskedKey,
    model,
  };
}

function getClient(repo, overrideKey) {
  const cfg = resolveAiConfig(repo);
  const key = (overrideKey || cfg.apiKey || '').trim();
  if (!key) {
    const err = new Error(
      'Kein Gemini API-Key hinterlegt. Bitte unter „Setup“ deinen Gemini API-Key eintragen.'
    );
    err.code = 'MISSING_API_KEY';
    err.status = 400;
    throw err;
  }
  return {
    ai: new GoogleGenAI({ apiKey: key }),
    model: cfg.model || DEFAULT_MODEL,
  };
}

function isRetryableModelError(err) {
  const status = Number(err?.status || err?.code || 0);
  const msg = String(err?.message || '');
  return (
    err?.name === 'AbortError' ||
    status === 503 ||
    status === 429 ||
    status === 404 ||
    status === 500 ||
    status === 504 ||
    msg.includes('TIMEOUT') ||
    msg.includes('AbortError') ||
    msg.includes('"code":503') ||
    msg.includes('"code":429') ||
    msg.includes('"code":404') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand') ||
    msg.includes('no longer available')
  );
}

function formatCleanAiError(err) {
  const msg = String(err?.message || '');
  if (msg.includes('API_KEY_INVALID') || msg.includes('API key not valid')) {
    const clean = new Error('Der eingegebene Gemini API-Key ist ungültig. Bitte im Setup prüfen.');
    clean.status = 400;
    return clean;
  }
  if (msg.includes('high demand') || msg.includes('UNAVAILABLE') || msg.includes('TIMEOUT')) {
    const clean = new Error('Die Gemini-Server sind momentan stark ausgelastet. Bitte kurz erneut versuchen.');
    clean.status = 503;
    return clean;
  }
  return err;
}

function buildCandidateChain(preferredModel) {
  const ordered = [];
  const add = (m) => {
    if (m && !ordered.includes(m)) ordered.push(m);
  };
  if (lastWorkingModel) {
    add(lastWorkingModel);
  }
  if (!preferredModel || preferredModel === 'gemini-3.8-flash') {
    FALLBACK_MODELS.forEach(add);
  } else {
    add(preferredModel);
    FALLBACK_MODELS.forEach(add);
  }
  return ordered;
}

async function generateWithFailover(ai, preferredModel, params, timeoutMs = 8000) {
  const candidates = buildCandidateChain(preferredModel);

  let lastErr = null;
  for (const candidateModel of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const mergedConfig = { ...(params.config || {}), abortSignal: controller.signal };
      if (candidateModel === 'gemini-3-flash-preview') {
        mergedConfig.thinkingConfig = { thinkingLevel: 'minimal' };
      } else if (candidateModel === 'gemini-3.6-flash') {
        mergedConfig.thinkingConfig = { thinkingLevel: 'low' };
      }
      const response = await ai.models.generateContent({
        ...params,
        model: candidateModel,
        config: mergedConfig,
      });
      lastWorkingModel = candidateModel;
      return { response, usedModel: candidateModel };
    } catch (err) {
      lastErr = err;
      if (lastWorkingModel === candidateModel) {
        lastWorkingModel = null;
      }
      if (!isRetryableModelError(err)) {
        throw formatCleanAiError(err);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw formatCleanAiError(lastErr);
}

function describeTasteSlider(val) {
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

async function testApiKey(repo, candidateKey, candidateModel) {
  const { ai, model } = getClient(repo, candidateKey);
  const targetModel = candidateModel || model;
  const { response, usedModel } = await generateWithFailover(ai, targetModel, {
    contents: 'Antworte nur mit dem Wort: BEREIT',
  });
  return {
    ok: true,
    model: usedModel,
    requestedModel: targetModel,
    reply: (response.text || '').trim(),
  };
}

async function scanCoffeeLabel(repo, { base64Data, mimeType }) {
  const { ai, model } = getClient(repo);
  const todayIso = new Date().toISOString().slice(0, 10);

  const { response, usedModel } = await generateWithFailover(ai, model, {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Analysiere dieses Foto eines Kaffee-Etiketts / einer Kaffeeverpackung sehr sorgfältig.
Heutiges Datum zur Orientierung: ${todayIso}.
Extrahiere alle erkennbaren Informationen in die JSON-Felder:
- roaster: Name der Rösterei / Marke (z. B. "19grams", "The Barn", "Gorilla", "Elbgold").
- name: Name des Kaffees / Espresso-Blends / Single Origins.
- roast_date: Röstdatum im Format YYYY-MM-DD, falls auf dem Etikett angegeben (achte auf "Röstdatum", "Geröstet am", "Roasted on" oder Stempeldaten). Falls nicht erkennbar, leerer String "".
- expiry_date: Mindesthaltbarkeitsdatum / Ablaufdatum (MHD / Best Before) im Format YYYY-MM-DD, falls angegeben. Falls nicht erkennbar, leerer String "".
- flavor_notes: Geschmacksnoten auf Deutsch als kommagetrennte Liste (z. B. "Schokoladig, Nussig, Karamell"). Übersetze englische Geschmacksnoten sinnvoll ins Deutsche.
- roast_level: Röstgrad ("Hell", "Mittel" oder "Dunkel"), falls erkennbar, sonst "".
- origin: Herkunftsland / Region / Varietät, falls erkennbar, sonst "".
- summary_hint: Kurzer freundlicher Hinweis auf Deutsch (1 Satz), welche Felder erkannt wurden.`,
          },
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: base64Data,
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          roaster: { type: Type.STRING },
          name: { type: Type.STRING },
          roast_date: { type: Type.STRING },
          expiry_date: { type: Type.STRING },
          flavor_notes: { type: Type.STRING },
          roast_level: { type: Type.STRING },
          origin: { type: Type.STRING },
          summary_hint: { type: Type.STRING },
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
    },
  }, 15000);

  const parsed = JSON.parse(response.text || '{}');
  return { ...parsed, usedModel };
}

async function generateBeanRecipe(repo, beanInput) {
  const { ai, model } = getClient(repo);
  const equipment = repo.getActiveEquipment();
  const calibration = repo.getCalibrationStatus();

  const machineDesc = equipment.machine
    ? `${equipment.machine.name}${equipment.machine.notes ? ` (${equipment.machine.notes})` : ''}`
    : 'Bezzera Luce S PID (18g Sieb)';
  const grinderDesc = equipment.grinder
    ? `${equipment.grinder.name}${equipment.grinder.notes ? ` (${equipment.grinder.notes})` : ''}`
    : 'DF54';

  const roastAge = computeRoastAgeText(beanInput.roast_date);

  const prompt = `Du bist ein erfahrener Specialty-Coffee Head-Barista. Erstelle ein präzises, praxisnahes Espresso-Grundrezept und Zubereitungstipps auf Deutsch für folgende Bohne und folgendes Equipment:

Equipment des Nutzers:
- Maschine: ${machineDesc}
- Mühle: ${grinderDesc}
- Siebgröße: 18g Sieb

Bohnendaten:
- Röster: ${beanInput.roaster || 'Unbekannt'}
- Name: ${beanInput.name || 'Unbekannt'}
- Röstdatum / Alter: ${roastAge}
- Ablaufdatum (MHD): ${beanInput.expiry_date || 'k.A.'}
- Geschmacksnoten: ${beanInput.flavor_notes || 'k.A.'}

Nutzer-Geschmacksprofil:
- ${calibration.summaryForAi}

Anforderungen an das Feld "recipe_tips":
Formuliere ein kurzes, übersichtliches Startrezept für das 18g Sieb:
1. Dosis & Zielmenge: 18g In -> empfohlene Gramm Out (inkl. Ratio, z. B. 1:2.0 = 36g).
2. Ziel-Bezugszeit in Sekunden & empfohlene PID-Temperatur in °C.
3. Mahlgrad-Orientierung an der ${equipment.grinder ? equipment.grinder.name : 'DF54'}.
4. 1–2 knappe Tipps zu Röstalter und Geschmacksnoten.`;

  const { response, usedModel } = await generateWithFailover(ai, model, {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          recipe_tips: { type: Type.STRING },
          recommended_temp_c: { type: Type.NUMBER },
          recommended_ratio: { type: Type.NUMBER },
          recommended_time_s: { type: Type.NUMBER },
        },
        required: ['recipe_tips', 'recommended_temp_c', 'recommended_ratio', 'recommended_time_s'],
      },
    },
  }, 15000);

  const parsed = JSON.parse(response.text || '{}');
  return { ...parsed, usedModel };
}

async function analyzeShotBarista(repo, payload) {
  const { ai, model } = getClient(repo);
  const equipment = repo.getActiveEquipment();
  const calibration = repo.getCalibrationStatus();

  const bean = payload.bean_id ? repo.getBean(Number(payload.bean_id)) : null;
  const recentShots = payload.bean_id
    ? repo.listShots({ beanId: Number(payload.bean_id), limit: 3 })
    : repo.listShots({ limit: 3 });

  const inG = Number(payload.in_g);
  const outG = Number(payload.out_g);
  const timeS = Number(payload.time_s);
  const tempC = Number(payload.temp_c);
  const grind = String(payload.grind_setting || '').trim();
  const stars = Number(payload.stars || 3);
  const slider = Number(payload.taste_slider ?? 0);
  const ratio = inG > 0 ? (outG / inG).toFixed(2) : '0';
  const flow = timeS > 0 ? (outG / timeS).toFixed(2) : '0';

  const historyLines = recentShots.length
    ? recentShots
        .map(
          (s, idx) =>
            `  #${idx + 1}: ${s.in_g}g In -> ${s.out_g}g Out in ${s.time_s}s @ ${s.temp_c}°C, Mahlgrad ${s.grind_setting} | ${s.stars}/5★, Slider ${s.taste_slider}`
        )
        .join('\n')
    : '  Keine vorherigen Bezüge gespeichert.';

  const refLine =
    bean && bean.ref_in_g !== null
      ? `Gespeichertes perfektes Referenzrezept dieser Bohne: ${bean.ref_in_g}g In -> ${bean.ref_out_g}g Out in ${bean.ref_time_s}s @ ${bean.ref_temp_c}°C, Mahlgrad ${bean.ref_grind}.`
      : 'Noch kein Referenzrezept für diese Bohne gespeichert.';

  const prompt = `Du bist ein präziser KI-Chef-Barista für Espresso-Dial-In (18g Sieb). Analysiere den aktuellen Espresso-Bezug und gib GENAU EINEN klaren, sofort umsetzbaren Hauptbefehl für den nächsten Shot aus.

Equipment:
- Maschine: ${equipment.machine ? equipment.machine.name : 'Bezzera Luce S PID'} (18g Sieb)
- Mühle: ${equipment.grinder ? equipment.grinder.name : 'DF54'}

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
- Geschmacks-Schieberegler (Sauer -1.0 <-> Neutral 0.0 <-> Bitter +1.0): ${describeTasteSlider(slider)}

Vorherige Bezüge zum Vergleich:
${historyLines}

Nutzer-Präferenzen:
- ${calibration.summaryForAi}

Wichtige Barista-Regeln für deine Antwort:
1. "command": Gib einen kurzen, konkreten Imperativ-Befehl auf Deutsch aus (max. 14 Wörter), z. B. "Mahlgrad um 0.5 Stufen feiner stellen (auf 14.5)" oder "Ergebnis (Out) um 2g auf 38g erhöhen" oder "PID-Temperatur um 1°C auf 92°C senken". Wenn der Shot bereits perfekt ist (5 Sterne & Slider neutral um 0), lobe den Bezug und empfiehl, ihn mit "Rezept speichern" als Referenzwert zu sichern.
2. Verändere für den nächsten Shot primär EINE Stellschraube (Mahlgrad ODER Out ODER Temperatur).
3. "suggested_params": Liefere die exakten empfohlenen Parameter für den nächsten Bezug (in_g, out_g, time_s, temp_c, grind_setting), passend zu deinem Befehl.`;

  const { response, usedModel } = await generateWithFailover(ai, model, {
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          command: { type: Type.STRING },
          extraction_state: { type: Type.STRING },
          diagnosis: { type: Type.STRING },
          suggested_params: {
            type: Type.OBJECT,
            properties: {
              in_g: { type: Type.NUMBER },
              out_g: { type: Type.NUMBER },
              time_s: { type: Type.NUMBER },
              temp_c: { type: Type.NUMBER },
              grind_setting: { type: Type.STRING },
            },
            required: ['in_g', 'out_g', 'time_s', 'temp_c', 'grind_setting'],
          },
        },
        required: ['command', 'extraction_state', 'diagnosis', 'suggested_params'],
      },
    },
  }, 15000);

  const parsed = JSON.parse(response.text || '{}');
  return { ...parsed, usedModel };
}

module.exports = {
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  resolveAiConfig,
  testApiKey,
  scanCoffeeLabel,
  generateBeanRecipe,
  analyzeShotBarista,
};
