const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createDatabase(customDbPath) {
  const dbPath = customDbPath || path.join(__dirname, '..', 'data', 'espresso.db');
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('machine', 'grinder')),
      name TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS beans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roaster TEXT NOT NULL,
      name TEXT NOT NULL,
      roast_date TEXT NOT NULL DEFAULT '',
      expiry_date TEXT NOT NULL DEFAULT '',
      flavor_notes TEXT NOT NULL DEFAULT '',
      roast_level TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT '',
      ai_recipe_tips TEXT NOT NULL DEFAULT '',
      rating REAL DEFAULT NULL,
      image_data TEXT NOT NULL DEFAULT '',
      ref_in_g REAL DEFAULT NULL,
      ref_out_g REAL DEFAULT NULL,
      ref_time_s REAL DEFAULT NULL,
      ref_temp_c REAL DEFAULT NULL,
      ref_grind TEXT DEFAULT NULL,
      ref_saved_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bean_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bean_id INTEGER NOT NULL REFERENCES beans(id) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK(score >= 1 AND score <= 10),
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bean_id INTEGER REFERENCES beans(id) ON DELETE SET NULL,
      machine_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL,
      grinder_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL,
      basket_size INTEGER DEFAULT NULL,
      in_g REAL NOT NULL,
      out_g REAL NOT NULL,
      time_s REAL NOT NULL,
      temp_c REAL NOT NULL,
      grind_setting TEXT NOT NULL,
      stars INTEGER NOT NULL CHECK(stars >= 1 AND stars <= 5),
      taste_slider REAL NOT NULL CHECK(taste_slider >= -1.0 AND taste_slider <= 1.0),
      notes TEXT NOT NULL DEFAULT '',
      ai_diagnosis TEXT NOT NULL DEFAULT '',
      ai_command TEXT NOT NULL DEFAULT '',
      ai_suggested_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed initial default equipment if none exist yet:
  // Bezzera Luce S PID (Maschine) & DF54 (Mühle)
  const equipmentCount = db.prepare('SELECT COUNT(*) AS count FROM equipment').get().count;
  if (equipmentCount === 0) {
    const insertEquip = db.prepare(`
      INSERT INTO equipment (type, name, brand, model, notes, is_default)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertEquip.run(
      'machine',
      'Bezzera Luce S PID',
      'Bezzera',
      'Luce S PID',
      'E61 Brühgruppe mit PID-Temperaturregelung, 18g Sieb',
      1
    );
    insertEquip.run(
      'grinder',
      'DF54',
      'DF / Turin',
      'DF54',
      '54mm Flat Burrs Single-Dose Mühle, stufenlos',
      1
    );
  } else {
    // Update legacy default note from 16g/20g to 18g Sieb if untouched
    db.prepare(`
      UPDATE equipment
      SET notes = 'E61 Brühgruppe mit PID-Temperaturregelung, 18g Sieb'
      WHERE name = 'Bezzera Luce S PID' AND notes LIKE '%16g%'
    `).run();
  }

  // Upgrade outdated stored Gemini 2.x model setting to gemini-3.8-flash
  db.prepare(`
    UPDATE app_settings
    SET value = 'gemini-3.8-flash', updated_at = datetime('now')
    WHERE key = 'gemini_model' AND value LIKE 'gemini-2.%'
  `).run();

  function normalizeRow(row) {
    return row ? { ...row } : null;
  }

  function normalizeRows(rows) {
    return rows.map((r) => ({ ...r }));
  }

  // --- Settings ---
  function getSetting(key) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  function setSetting(key, value) {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));
  }

  function deleteSetting(key) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  // --- Equipment ---
  function listEquipment() {
    return normalizeRows(
      db.prepare('SELECT * FROM equipment ORDER BY type ASC, is_default DESC, id ASC').all()
    );
  }

  function getActiveEquipment() {
    const all = listEquipment();
    const machine =
      all.find((e) => e.type === 'machine' && e.is_default === 1) ||
      all.find((e) => e.type === 'machine') ||
      null;
    const grinder =
      all.find((e) => e.type === 'grinder' && e.is_default === 1) ||
      all.find((e) => e.type === 'grinder') ||
      null;
    return { machine, grinder };
  }

  function createEquipment({ type, name, brand = '', model = '', notes = '', is_default = 0 }) {
    const existingOfType = db
      .prepare('SELECT COUNT(*) AS count FROM equipment WHERE type = ?')
      .get(type).count;
    const makeDefault = is_default || existingOfType === 0 ? 1 : 0;

    if (makeDefault) {
      db.prepare('UPDATE equipment SET is_default = 0 WHERE type = ?').run(type);
    }

    const res = db
      .prepare(`
        INSERT INTO equipment (type, name, brand, model, notes, is_default)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(type, name.trim(), brand.trim(), model.trim(), notes.trim(), makeDefault);

    return normalizeRow(db.prepare('SELECT * FROM equipment WHERE id = ?').get(res.lastInsertRowid));
  }

  function updateEquipment(id, { type, name, brand, model, notes, is_default }) {
    const current = normalizeRow(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id));
    if (!current) return null;

    const nextType = type || current.type;
    const nextDefault = is_default !== undefined ? (is_default ? 1 : 0) : current.is_default;

    if (nextDefault === 1) {
      db.prepare('UPDATE equipment SET is_default = 0 WHERE type = ?').run(nextType);
    }

    db.prepare(`
      UPDATE equipment
      SET type = ?, name = ?, brand = ?, model = ?, notes = ?, is_default = ?
      WHERE id = ?
    `).run(
      nextType,
      name !== undefined ? name.trim() : current.name,
      brand !== undefined ? brand.trim() : current.brand,
      model !== undefined ? model.trim() : current.model,
      notes !== undefined ? notes.trim() : current.notes,
      nextDefault,
      id
    );

    return normalizeRow(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id));
  }

  function setDefaultEquipment(id) {
    const current = normalizeRow(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id));
    if (!current) return null;
    db.prepare('UPDATE equipment SET is_default = 0 WHERE type = ?').run(current.type);
    db.prepare('UPDATE equipment SET is_default = 1 WHERE id = ?').run(id);
    return normalizeRow(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id));
  }

  function deleteEquipment(id) {
    const current = normalizeRow(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id));
    if (!current) return false;
    db.prepare('DELETE FROM equipment WHERE id = ?').run(id);
    if (current.is_default === 1) {
      const fallback = db
        .prepare('SELECT id FROM equipment WHERE type = ? ORDER BY id ASC LIMIT 1')
        .get(current.type);
      if (fallback) {
        db.prepare('UPDATE equipment SET is_default = 1 WHERE id = ?').run(fallback.id);
      }
    }
    return true;
  }

  // --- Beans & Ratings & Calibration ---
  function enrichBean(bean) {
    if (!bean) return null;
    const stats = db
      .prepare(`
        SELECT COUNT(*) AS rating_count, ROUND(AVG(score), 1) AS avg_rating
        FROM bean_ratings
        WHERE bean_id = ?
      `)
      .get(bean.id);
    const shotCount = db
      .prepare('SELECT COUNT(*) AS count FROM shots WHERE bean_id = ?')
      .get(bean.id).count;
    const ratings = normalizeRows(
      db
        .prepare('SELECT id, score, comment, created_at FROM bean_ratings WHERE bean_id = ? ORDER BY id DESC LIMIT 10')
        .all(bean.id)
    );
    return {
      ...bean,
      rating_count: stats.rating_count || 0,
      avg_rating: stats.avg_rating !== null ? stats.avg_rating : bean.rating,
      shot_count: shotCount || 0,
      ratings,
    };
  }

  function listBeans() {
    const rows = normalizeRows(
      db.prepare('SELECT * FROM beans ORDER BY updated_at DESC, id DESC').all()
    );
    return rows.map(enrichBean);
  }

  function getBean(id) {
    const row = normalizeRow(db.prepare('SELECT * FROM beans WHERE id = ?').get(id));
    return enrichBean(row);
  }

  function addBeanRating(beanId, score, comment = '') {
    const numericScore = Math.max(1, Math.min(10, Math.round(Number(score))));
    db.prepare(`
      INSERT INTO bean_ratings (bean_id, score, comment)
      VALUES (?, ?, ?)
    `).run(beanId, numericScore, String(comment || '').trim());

    const avgRow = db
      .prepare('SELECT ROUND(AVG(score), 1) AS avg_score FROM bean_ratings WHERE bean_id = ?')
      .get(beanId);
    db.prepare(`
      UPDATE beans
      SET rating = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(avgRow.avg_score, beanId);

    return getBean(beanId);
  }

  function createBean(data) {
    const {
      roaster = '',
      name = '',
      roast_date = '',
      expiry_date = '',
      flavor_notes = '',
      roast_level = '',
      origin = '',
      ai_recipe_tips = '',
      rating = null,
      image_data = '',
    } = data;

    const res = db
      .prepare(`
        INSERT INTO beans (
          roaster, name, roast_date, expiry_date, flavor_notes,
          roast_level, origin, ai_recipe_tips, rating, image_data
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        String(roaster).trim(),
        String(name).trim(),
        String(roast_date || '').trim(),
        String(expiry_date || '').trim(),
        String(flavor_notes || '').trim(),
        String(roast_level || '').trim(),
        String(origin || '').trim(),
        String(ai_recipe_tips || '').trim(),
        rating !== null && rating !== '' && rating !== undefined ? Number(rating) : null,
        String(image_data || '')
      );

    const beanId = res.lastInsertRowid;
    if (rating !== null && rating !== '' && rating !== undefined && !Number.isNaN(Number(rating))) {
      addBeanRating(beanId, Number(rating), 'Initiale Bewertung');
    }

    return getBean(beanId);
  }

  function updateBean(id, data) {
    const current = normalizeRow(db.prepare('SELECT * FROM beans WHERE id = ?').get(id));
    if (!current) return null;

    db.prepare(`
      UPDATE beans
      SET roaster = ?,
          name = ?,
          roast_date = ?,
          expiry_date = ?,
          flavor_notes = ?,
          roast_level = ?,
          origin = ?,
          ai_recipe_tips = ?,
          image_data = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      data.roaster !== undefined ? String(data.roaster).trim() : current.roaster,
      data.name !== undefined ? String(data.name).trim() : current.name,
      data.roast_date !== undefined ? String(data.roast_date).trim() : current.roast_date,
      data.expiry_date !== undefined ? String(data.expiry_date).trim() : current.expiry_date,
      data.flavor_notes !== undefined ? String(data.flavor_notes).trim() : current.flavor_notes,
      data.roast_level !== undefined ? String(data.roast_level).trim() : current.roast_level,
      data.origin !== undefined ? String(data.origin).trim() : current.origin,
      data.ai_recipe_tips !== undefined ? String(data.ai_recipe_tips).trim() : current.ai_recipe_tips,
      data.image_data !== undefined ? String(data.image_data) : current.image_data,
      id
    );

    if (data.new_rating !== undefined && data.new_rating !== null && data.new_rating !== '') {
      addBeanRating(id, Number(data.new_rating), data.rating_comment || '');
    }

    return getBean(id);
  }

  function saveBeanReferenceRecipe(beanId, { in_g, out_g, time_s, temp_c, grind_setting }) {
    const current = normalizeRow(db.prepare('SELECT * FROM beans WHERE id = ?').get(beanId));
    if (!current) return null;

    db.prepare(`
      UPDATE beans
      SET ref_in_g = ?,
          ref_out_g = ?,
          ref_time_s = ?,
          ref_temp_c = ?,
          ref_grind = ?,
          ref_saved_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      Number(in_g),
      Number(out_g),
      Number(time_s),
      Number(temp_c),
      String(grind_setting).trim(),
      beanId
    );

    return getBean(beanId);
  }

  function deleteBean(id) {
    const res = db.prepare('DELETE FROM beans WHERE id = ?').run(id);
    return res.changes > 0;
  }

  function getCalibrationStatus() {
    const totalRatings = db.prepare('SELECT COUNT(*) AS count FROM bean_ratings').get().count;
    const ratedBeansCount = db
      .prepare('SELECT COUNT(DISTINCT bean_id) AS count FROM bean_ratings')
      .get().count;

    const isCalibrating = totalRatings < 3;
    const minRequired = 3;
    const remaining = Math.max(0, minRequired - totalRatings);

    // Compute flavor & roast preference profile from rated beans
    const ratedRows = normalizeRows(
      db
        .prepare(`
          SELECT br.score, b.roaster, b.name, b.flavor_notes, b.roast_level
          FROM bean_ratings br
          JOIN beans b ON b.id = br.bean_id
          ORDER BY br.id DESC
        `)
        .all()
    );

    const noteWeights = new Map();
    const dislikedNotes = new Set();

    for (const r of ratedRows) {
      const notes = String(r.flavor_notes || '')
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

    const sortedNotes = Array.from(noteWeights.values())
      .map((item) => ({
        label: item.label,
        avgScore: Number((item.totalScore / item.count).toFixed(1)),
        count: item.count,
      }))
      .sort((a, b) => b.avgScore - a.avgScore || b.count - a.count);

    const favoriteNotes = sortedNotes.filter((n) => n.avgScore >= 6.5).slice(0, 5);
    const topBeans = ratedRows
      .filter((r) => r.score >= 7)
      .slice(0, 3)
      .map((r) => `${r.roaster} ${r.name} (${r.score}/10)`);

    return {
      totalRatings,
      ratedBeansCount,
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

  // --- Shots ---
  const shotSelectSql = `
    SELECT s.*,
           b.roaster AS bean_roaster,
           b.name AS bean_name,
           b.flavor_notes AS bean_flavor_notes,
           m.name AS machine_name,
           g.name AS grinder_name
    FROM shots s
    LEFT JOIN beans b ON b.id = s.bean_id
    LEFT JOIN equipment m ON m.id = s.machine_id
    LEFT JOIN equipment g ON g.id = s.grinder_id
  `;

  function formatShot(row) {
    if (!row) return null;
    const normalized = { ...row };
    if (normalized.ai_suggested_json) {
      try {
        normalized.ai_suggested = JSON.parse(normalized.ai_suggested_json);
      } catch {
        normalized.ai_suggested = null;
      }
    } else {
      normalized.ai_suggested = null;
    }
    return normalized;
  }

  function getLatestShot() {
    const row = db
      .prepare(`${shotSelectSql} ORDER BY s.id DESC LIMIT 1`)
      .get();
    return formatShot(row);
  }

  function listShots({ beanId = null, limit = 30 } = {}) {
    if (beanId) {
      return db
        .prepare(`${shotSelectSql} WHERE s.bean_id = ? ORDER BY s.id DESC LIMIT ?`)
        .all(Number(beanId), Number(limit))
        .map(formatShot);
    }
    return db
      .prepare(`${shotSelectSql} ORDER BY s.id DESC LIMIT ?`)
      .all(Number(limit))
      .map(formatShot);
  }

  function getShot(id) {
    const row = db.prepare(`${shotSelectSql} WHERE s.id = ?`).get(id);
    return formatShot(row);
  }

  function createShot(data) {
    const active = getActiveEquipment();
    const machineId =
      data.machine_id !== undefined && data.machine_id !== null && data.machine_id !== ''
        ? Number(data.machine_id)
        : active.machine
        ? active.machine.id
        : null;
    const grinderId =
      data.grinder_id !== undefined && data.grinder_id !== null && data.grinder_id !== ''
        ? Number(data.grinder_id)
        : active.grinder
        ? active.grinder.id
        : null;
    const beanId =
      data.bean_id !== undefined && data.bean_id !== null && data.bean_id !== ''
        ? Number(data.bean_id)
        : null;

    const stars = Math.max(1, Math.min(5, Math.round(Number(data.stars ?? 3))));
    const slider = Math.max(-1, Math.min(1, Number(data.taste_slider ?? 0)));

    const res = db
      .prepare(`
        INSERT INTO shots (
          bean_id, machine_id, grinder_id, basket_size,
          in_g, out_g, time_s, temp_c, grind_setting,
          stars, taste_slider, notes, ai_diagnosis, ai_command, ai_suggested_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        beanId,
        machineId,
        grinderId,
        data.basket_size ? Number(data.basket_size) : null,
        Number(data.in_g),
        Number(data.out_g),
        Number(data.time_s),
        Number(data.temp_c),
        String(data.grind_setting).trim(),
        stars,
        slider,
        String(data.notes || '').trim(),
        String(data.ai_diagnosis || '').trim(),
        String(data.ai_command || '').trim(),
        data.ai_suggested ? JSON.stringify(data.ai_suggested) : ''
      );

    return getShot(res.lastInsertRowid);
  }

  function updateShotAiFeedback(id, { ai_diagnosis, ai_command, ai_suggested }) {
    db.prepare(`
      UPDATE shots
      SET ai_diagnosis = ?, ai_command = ?, ai_suggested_json = ?
      WHERE id = ?
    `).run(
      String(ai_diagnosis || '').trim(),
      String(ai_command || '').trim(),
      ai_suggested ? JSON.stringify(ai_suggested) : '',
      id
    );
    return getShot(id);
  }

  function deleteShot(id) {
    const res = db.prepare('DELETE FROM shots WHERE id = ?').run(id);
    return res.changes > 0;
  }

  return {
    db,
    getSetting,
    setSetting,
    deleteSetting,
    listEquipment,
    getActiveEquipment,
    createEquipment,
    updateEquipment,
    setDefaultEquipment,
    deleteEquipment,
    listBeans,
    getBean,
    createBean,
    updateBean,
    addBeanRating,
    saveBeanReferenceRecipe,
    deleteBean,
    getCalibrationStatus,
    getLatestShot,
    listShots,
    getShot,
    createShot,
    updateShotAiFeedback,
    deleteShot,
  };
}

module.exports = { createDatabase };
