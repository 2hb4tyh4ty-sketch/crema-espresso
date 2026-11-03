# ☕ CremaAI – Espresso-Tracking & KI-Barista

Mobile-optimierte Web-Anwendung im Dark Mode zur Erfassung und KI-gestützten Optimierung von Espresso-Bezügen mit **Node.js/Express**, lokaler **SQLite-Datenbank** (`node:sqlite`) und der **Google Gemini API** (`@google/genai`).

## Features

### Phase 1: Profile & Bohnen-Management
- **Geräteverwaltung**: Vorinstallierte Standardgeräte **Bezzera Luce S PID** (Espressomaschine) und **DF54** (Mühle), jederzeit erweiterbar.
- **Bohnen-Datenbank & Gemini Vision**:
  - Manuelle Erfassung oder direkter **Kamera-/Foto-Upload** auf dem Smartphone.
  - Automatisches Auslesen des Etiketts via **Gemini Vision API** (*Röster, Name, anpassbares Röstdatum, Ablaufdatum/MHD, Geschmacksnoten, Röstgrad & Herkunft*).
- **KI-Grundrezepte & Zubereitungstipps**: Editierbares Rezeptfeld mit 1-Klick-Generierung (`gemini-3.8-flash`) passend zu Bohnendaten, Röstalter, **18g Sieb** und aktivem Equipment.
- **1–10 Bewertungsskala & Präferenz-Kalibrierung**:
  - Solange weniger als 3 Bohnen-Bewertungen vorliegen, zeigt die App den Status **„Kalibrierung läuft...“** an.
  - Ab 3 Bewertungen fließt das gelernte Geschmacksprofil automatisch in die KI-Empfehlungen ein.

### Phase 2: Bezugs-Tracking & KI-Barista
- **Einzelbezugs-Maske**: Übersichtliche Zeilen für *Dosis In (g)* (**optimiert für 18g Sieb**), *Ergebnis Out (g)* inkl. Live-Brew-Ratio, *Bezugszeit (s)* inkl. integrierter Live-Stoppuhr, *PID-Temperatur (°C)* und *Mahlgrad*.
- ** Automatisches Vorausfüllen**: Beim Laden der Anwendung werden zwingend die exakten Parameter des vorherigen Bezugs aus der SQLite-Datenbank vorausgefüllt.
- **Shot-Bewertung**: 1–5 Sterne für den Gesamteindruck sowie ein **stufenloser Schieberegler** von **Sauer** (links) über **Neutral** (Mitte) bis **Bitter** (rechts).
- **KI-Barista**: Analysiert Shot-Parameter und Geschmacks-Slider mit der Gemini API und gibt einen konkreten Befehl für den nächsten Shot aus (inkl. 1-Klick-Übernahme in die Maske).
- **Referenzrezept speichern**: Der Button **„Rezept speichern“** speichert bei einem perfekten Bezug (**5 Sterne + neutraler Slider**) die aktuellen Parameter als festen Referenzwert für die jeweilige Bohne.

## Schnellstart

1. **Gemini API-Key hinterlegen** (optional in `.env` oder direkt in der Web-App oben rechts über **„API-Key fehlt / KI Bereit“**):
   ```bash
   cp .env.example .env
   # GEMINI_API_KEY=... eintragen (https://aistudio.google.com/apikey)
   ```

2. **Server starten**:
   ```bash
   node server.js
   ```
   Die Anwendung läuft anschließend unter `http://localhost:3000` (für den Zugriff vom Smartphone im selben WLAN `http://<PC-IP>:3000` öffnen).

3. **Tests ausführen**:
   ```bash
   node --test tests/api.test.js
   ```
