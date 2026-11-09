const os = require('node:os');
const path = require('node:path');
const dotenv = require('dotenv');
const express = require('express');
const multer = require('multer');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(os.homedir(), '.env'), override: false });

const { createDatabase } = require('./src/db');
const {
  resolveAiConfig,
  testApiKey,
  scanCoffeeLabel,
  generateBeanRecipe,
  analyzeShotBarista,
} = require('./src/gemini');

function createApp(options = {}) {
  const repo = createDatabase(options.dbPath);
  const aiService = options.aiService || {
    resolveAiConfig,
    testApiKey,
    scanCoffeeLabel,
    generateBeanRecipe,
    analyzeShotBarista,
  };

  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
  });

  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  function buildAiStatus() {
    const cfg = aiService.resolveAiConfig(repo);
    return {
      configured: cfg.configured,
      source: cfg.source,
      maskedKey: cfg.maskedKey,
      model: cfg.model,
      githubPagesUrl: repo.getSetting('github_pages_url') || '',
    };
  }

  // --- Bootstrap ---
  app.get('/api/bootstrap', (_req, res) => {
    res.json({
      equipment: repo.listEquipment(),
      activeEquipment: repo.getActiveEquipment(),
      beans: repo.listBeans(),
      calibration: repo.getCalibrationStatus(),
      latestShot: repo.getLatestShot(),
      recentShots: repo.listShots({ limit: 25 }),
      aiStatus: buildAiStatus(),
    });
  });

  // --- Backup Export & Import ---
  app.get('/api/backup', (_req, res) => {
    res.json(repo.exportBackup());
  });

  app.post('/api/backup', (req, res, next) => {
    try {
      repo.importBackup(req.body || {});
      res.json({
        ok: true,
        equipment: repo.listEquipment(),
        activeEquipment: repo.getActiveEquipment(),
        beans: repo.listBeans(),
        calibration: repo.getCalibrationStatus(),
        latestShot: repo.getLatestShot(),
        recentShots: repo.listShots({ limit: 25 }),
        aiStatus: buildAiStatus(),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- AI Settings ---
  app.get('/api/settings/ai-status', (_req, res) => {
    res.json(buildAiStatus());
  });

  app.post('/api/settings/api-key', (req, res) => {
    const { apiKey, model } = req.body || {};
    if (apiKey !== undefined) {
      const trimmed = String(apiKey).trim();
      if (trimmed) {
        repo.setSetting('gemini_api_key', trimmed);
      } else {
        repo.deleteSetting('gemini_api_key');
      }
    }
    if (model !== undefined && String(model).trim()) {
      repo.setSetting('gemini_model', String(model).trim());
    }
    res.json({ ok: true, aiStatus: buildAiStatus() });
  });

  app.post('/api/settings/test-ai', async (req, res, next) => {
    try {
      const { apiKey, model } = req.body || {};
      const result = await aiService.testApiKey(repo, apiKey, model);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/settings/mobile-setup-link', (req, res) => {
    const remote = req.ip || req.socket?.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return res.status(403).json({ error: 'Nur lokal auf diesem PC erlaubt.' });
    }
    const baseUrl = String(req.body?.baseUrl || repo.getSetting('github_pages_url') || '')
      .trim()
      .replace(/\/+$/, '');
    if (!baseUrl.startsWith('https://')) {
      return res.status(400).json({ error: 'Noch keine GitHub-Pages HTTPS-URL hinterlegt.' });
    }
    const cfg = aiService.resolveAiConfig(repo);
    if (!cfg.apiKey) {
      return res.status(400).json({ error: 'Bitte zuerst einen Gemini API-Key speichern.' });
    }
    res.json({
      setupUrl: `${baseUrl}/#setupKey=${encodeURIComponent(cfg.apiKey)}`,
    });
  });

  // --- Phase 1: Equipment ---
  app.get('/api/equipment', (_req, res) => {
    res.json({
      equipment: repo.listEquipment(),
      activeEquipment: repo.getActiveEquipment(),
    });
  });

  app.post('/api/equipment', (req, res) => {
    const { type, name, brand, model, notes, is_default } = req.body || {};
    if (!type || !['machine', 'grinder'].includes(type)) {
      return res.status(400).json({ error: 'Ungültiger Gerätetyp (machine oder grinder erwartet).' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Gerätename ist erforderlich.' });
    }
    const created = repo.createEquipment({ type, name, brand, model, notes, is_default });
    res.status(201).json({
      item: created,
      equipment: repo.listEquipment(),
      activeEquipment: repo.getActiveEquipment(),
    });
  });

  app.put('/api/equipment/:id', (req, res) => {
    const id = Number(req.params.id);
    if (req.body.type && !['machine', 'grinder'].includes(req.body.type)) {
      return res.status(400).json({ error: 'Ungültiger Gerätetyp.' });
    }
    const updated = repo.updateEquipment(id, req.body || {});
    if (!updated) {
      return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    }
    res.json({
      item: updated,
      equipment: repo.listEquipment(),
      activeEquipment: repo.getActiveEquipment(),
    });
  });

  app.post('/api/equipment/:id/default', (req, res) => {
    const id = Number(req.params.id);
    const updated = repo.setDefaultEquipment(id);
    if (!updated) {
      return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    }
    res.json({
      item: updated,
      equipment: repo.listEquipment(),
      activeEquipment: repo.getActiveEquipment(),
    });
  });

  app.delete('/api/equipment/:id', (req, res) => {
    const id = Number(req.params.id);
    const ok = repo.deleteEquipment(id);
    if (!ok) {
      return res.status(404).json({ error: 'Gerät nicht gefunden.' });
    }
    res.json({
      ok: true,
      equipment: repo.listEquipment(),
      activeEquipment: repo.getActiveEquipment(),
    });
  });

  // --- Phase 1: Beans & 1-10 Rating / Calibration ---
  app.get('/api/beans', (_req, res) => {
    res.json({
      beans: repo.listBeans(),
      calibration: repo.getCalibrationStatus(),
    });
  });

  app.get('/api/beans/:id', (req, res) => {
    const bean = repo.getBean(Number(req.params.id));
    if (!bean) {
      return res.status(404).json({ error: 'Bohne nicht gefunden.' });
    }
    res.json({ bean, calibration: repo.getCalibrationStatus() });
  });

  app.post('/api/beans', (req, res) => {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'Name der Bohne ist erforderlich.' });
    }
    const created = repo.createBean({
      ...body,
      roaster: body.roaster && String(body.roaster).trim() ? body.roaster : 'Unbekannter Röster',
    });
    res.status(201).json({
      bean: created,
      beans: repo.listBeans(),
      calibration: repo.getCalibrationStatus(),
    });
  });

  app.put('/api/beans/:id', (req, res) => {
    const id = Number(req.params.id);
    const updated = repo.updateBean(id, req.body || {});
    if (!updated) {
      return res.status(404).json({ error: 'Bohne nicht gefunden.' });
    }
    res.json({
      bean: updated,
      beans: repo.listBeans(),
      calibration: repo.getCalibrationStatus(),
    });
  });

  app.post('/api/beans/:id/rate', (req, res) => {
    const id = Number(req.params.id);
    const existing = repo.getBean(id);
    if (!existing) {
      return res.status(404).json({ error: 'Bohne nicht gefunden.' });
    }
    const score = Number(req.body?.score);
    if (Number.isNaN(score) || score < 1 || score > 10) {
      return res.status(400).json({ error: 'Bewertung muss zwischen 1 und 10 liegen.' });
    }
    const updated = repo.addBeanRating(id, score, req.body?.comment || '');
    res.status(201).json({
      bean: updated,
      beans: repo.listBeans(),
      calibration: repo.getCalibrationStatus(),
    });
  });

  app.put('/api/beans/:id/reference-recipe', (req, res) => {
    const id = Number(req.params.id);
    const existing = repo.getBean(id);
    if (!existing) {
      return res.status(404).json({ error: 'Bohne nicht gefunden.' });
    }

    const { in_g, out_g, time_s, temp_c, grind_setting, stars, taste_slider } = req.body || {};
    if (
      in_g === undefined ||
      out_g === undefined ||
      time_s === undefined ||
      temp_c === undefined ||
      !String(grind_setting ?? '').trim()
    ) {
      return res.status(400).json({ error: 'Alle Bezugsparameter (In, Out, Zeit, Temperatur, Mahlgrad) sind erforderlich.' });
    }

    // Validate perfect shot criteria: 5 stars & neutral slider (within ±0.12 tolerance around 0)
    const numericStars = Number(stars);
    const numericSlider = Number(taste_slider);
    if (numericStars !== 5 || Number.isNaN(numericSlider) || Math.abs(numericSlider) > 0.12) {
      return res.status(400).json({
        error:
          'Referenzrezept kann nur bei einem perfekten Bezug (5 Sterne und neutraler Schieberegler) gespeichert werden.',
      });
    }

    const updated = repo.saveBeanReferenceRecipe(id, {
      in_g,
      out_g,
      time_s,
      temp_c,
      grind_setting,
    });

    res.json({
      bean: updated,
      beans: repo.listBeans(),
    });
  });

  app.delete('/api/beans/:id', (req, res) => {
    const ok = repo.deleteBean(Number(req.params.id));
    if (!ok) {
      return res.status(404).json({ error: 'Bohne nicht gefunden.' });
    }
    res.json({
      ok: true,
      beans: repo.listBeans(),
      calibration: repo.getCalibrationStatus(),
    });
  });

  // --- Phase 2: Shots ---
  app.get('/api/shots/latest', (_req, res) => {
    res.json({ latestShot: repo.getLatestShot() });
  });

  app.get('/api/shots', (req, res) => {
    const beanId = req.query.bean_id ? Number(req.query.bean_id) : null;
    const limit = req.query.limit ? Number(req.query.limit) : 30;
    res.json({
      latestShot: repo.getLatestShot(),
      shots: repo.listShots({ beanId, limit }),
    });
  });

  app.post('/api/shots', (req, res) => {
    const body = req.body || {};
    const inG = Number(body.in_g);
    const outG = Number(body.out_g);
    const timeS = Number(body.time_s);
    const tempC = Number(body.temp_c);
    const grind = String(body.grind_setting ?? '').trim();

    if ([inG, outG, timeS, tempC].some((v) => Number.isNaN(v) || v <= 0) || !grind) {
      return res.status(400).json({
        error: 'Bitte gültige Werte für In (g), Out (g), Zeit (s), Temperatur (°C) und Mahlgrad eingeben.',
      });
    }

    const shot = repo.createShot(body);
    res.status(201).json({
      shot,
      latestShot: repo.getLatestShot(),
      recentShots: repo.listShots({ limit: 25 }),
      beans: repo.listBeans(),
    });
  });

  app.delete('/api/shots/:id', (req, res) => {
    const ok = repo.deleteShot(Number(req.params.id));
    if (!ok) {
      return res.status(404).json({ error: 'Bezug nicht gefunden.' });
    }
    res.json({
      ok: true,
      latestShot: repo.getLatestShot(),
      recentShots: repo.listShots({ limit: 25 }),
      beans: repo.listBeans(),
    });
  });

  // --- Gemini AI Endpoints ---
  app.post('/api/ai/scan-label', upload.single('image'), async (req, res, next) => {
    try {
      let base64Data = '';
      let mimeType = 'image/jpeg';

      if (req.file) {
        base64Data = req.file.buffer.toString('base64');
        mimeType = req.file.mimetype || 'image/jpeg';
      } else if (req.body?.imageBase64) {
        const raw = String(req.body.imageBase64);
        const match = raw.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          base64Data = match[2];
        } else {
          base64Data = raw;
          mimeType = req.body.mimeType || 'image/jpeg';
        }
      } else {
        return res.status(400).json({ error: 'Kein Etiketten-Bild übermittelt.' });
      }

      const extracted = await aiService.scanCoffeeLabel(repo, { base64Data, mimeType });
      res.json({ extracted });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/ai/bean-recipe', async (req, res, next) => {
    try {
      const body = req.body || {};
      const generated = await aiService.generateBeanRecipe(repo, body);
      let updatedBean = null;
      if (body.bean_id && body.auto_save && generated.recipe_tips) {
        updatedBean = repo.updateBean(Number(body.bean_id), {
          ai_recipe_tips: generated.recipe_tips,
        });
      }
      res.json({
        ...generated,
        bean: updatedBean,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/ai/barista', async (req, res, next) => {
    try {
      const body = req.body || {};
      const inG = Number(body.in_g);
      const outG = Number(body.out_g);
      const timeS = Number(body.time_s);
      const tempC = Number(body.temp_c);
      const grind = String(body.grind_setting ?? '').trim();

      if ([inG, outG, timeS, tempC].some((v) => Number.isNaN(v) || v <= 0) || !grind) {
        return res.status(400).json({
          error: 'Bitte vollständige Shot-Parameter für die KI-Barista-Analyse angeben.',
        });
      }

      const analysis = await aiService.analyzeShotBarista(repo, body);
      let updatedShot = null;

      if (body.shot_id) {
        updatedShot = repo.updateShotAiFeedback(Number(body.shot_id), {
          ai_diagnosis: analysis.diagnosis,
          ai_command: analysis.command,
          ai_suggested: analysis.suggested_params,
        });
      }

      res.json({
        analysis,
        shot: updatedShot,
        recentShots: repo.listShots({ limit: 25 }),
      });
    } catch (err) {
      next(err);
    }
  });

  // Fallback for SPA navigation
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
  });

  // Central error handler
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === 'MISSING_API_KEY' ? 400 : 500);
    const message =
      err.message || 'Ein unerwarteter Fehler bei der Verarbeitung ist aufgetreten.';
    res.status(status).json({
      error: message,
      code: err.code || 'INTERNAL_ERROR',
    });
  });

  return { app, repo };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const { app } = createApp();
  app.listen(port, () => {
    console.log(`☕ CremaAI Espresso Barista läuft auf http://localhost:${port}`);
  });
}

module.exports = { createApp };
