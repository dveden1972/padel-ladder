// De app is oorspronkelijk gebouwd als Claude.ai-artifact en praat met opslag via
// `window.storage.get/set/delete/list` (zie https://docs.claude.com — dit is een
// functie die alleen binnen Claude.ai-artifacts bestaat). Deze module bootst diezelfde
// API na met de browser's localStorage, zodat de rest van de app-code (App.jsx)
// volledig ongewijzigd kan blijven.
//
// BELANGRIJKE BEPERKING: localStorage is per browser/apparaat. Twee mensen die de site
// bezoeken zien dus IEDER HUN EIGEN data, niet dezelfde gedeelde ladderstand. Voor een
// echt gedeelde ladder (alle leden zien dezelfde stand) heb je een backend/database
// nodig, bijvoorbeeld Supabase — zie README.md voor hoe je dat er later bij zet.

const PREFIX = "padel-ladder:";

function fullKey(key) {
  return `${PREFIX}${key}`;
}

const storage = {
  async get(key) {
    const raw = localStorage.getItem(fullKey(key));
    if (raw === null) return null;
    return { key, value: raw };
  },

  async set(key, value) {
    try {
      localStorage.setItem(fullKey(key), value);
      return { key, value };
    } catch (err) {
      // bijv. localStorage vol of geblokkeerd (privénavigatie in sommige browsers)
      console.error("storage.set failed", err);
      return null;
    }
  },

  async delete(key) {
    localStorage.removeItem(fullKey(key));
    return { key, deleted: true };
  },

  async list(prefix = "") {
    const fullPrefix = fullKey(prefix);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(fullPrefix)) {
        keys.push(k.slice(PREFIX.length));
      }
    }
    return { keys, prefix };
  },
};

if (typeof window !== "undefined") {
  window.storage = storage;
}

export default storage;
