// De app is oorspronkelijk gebouwd als Claude.ai-artifact en praat met opslag via
// `window.storage.get/set/delete/list`. Deze module bootst diezelfde API na, maar
// dan met een Supabase-tabel (`kv_store`) in plaats van localStorage — zodat alle
// gebruikers dezelfde, gedeelde data zien. De rest van de app-code (App.jsx)
// blijft hierdoor volledig ongewijzigd.
//
// Benodigde tabel in Supabase (zie ook README.md):
//
//   create table kv_store (
//     key text primary key,
//     value text not null,
//     updated_at timestamptz not null default now()
//   );

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Supabase-configuratie ontbreekt. Zet VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY in " +
      ".env (kopieer .env.example en vul je eigen projectgegevens in)."
  );
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const TABLE = "kv_store";

const storage = {
  async get(key) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (error) {
      console.error("storage.get failed", error);
      throw error;
    }
    if (!data) return null;
    return { key, value: data.value };
  },

  async set(key, value) {
    const { error } = await supabase
      .from(TABLE)
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

    if (error) {
      console.error("storage.set failed", error);
      return null; // App.jsx checkt op een falsy resultaat bij set-aanroepen
    }
    return { key, value };
  },

  async delete(key) {
    const { error } = await supabase.from(TABLE).delete().eq("key", key);

    if (error) {
      console.error("storage.delete failed", error);
      return null;
    }
    return { key, deleted: true };
  },

  async list(prefix = "") {
    const { data, error } = await supabase.from(TABLE).select("key").like("key", `${prefix}%`);

    if (error) {
      console.error("storage.list failed", error);
      throw error;
    }
    return { keys: (data || []).map((row) => row.key), prefix };
  },
};

if (typeof window !== "undefined") {
  window.storage = storage;
}

export default storage;
