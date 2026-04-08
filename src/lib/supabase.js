import { createClient } from "@supabase/supabase-js";

// ── Auth 전용 (비움마켓 Supabase) ──
const authUrl = import.meta.env.VITE_AUTH_SUPABASE_URL;
const authKey = import.meta.env.VITE_AUTH_SUPABASE_ANON_KEY;

export const supabaseAuth = createClient(authUrl, authKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// ── Data 전용 (더브릿지 ERP Supabase) ──
const dbUrl = import.meta.env.VITE_SUPABASE_URL;
const dbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseDB = createClient(dbUrl, dbKey);

// 하위 호환용 (기존 import { supabase } 대응)
export const supabase = supabaseDB;
