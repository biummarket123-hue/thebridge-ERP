import { createClient } from "@supabase/supabase-js";

// ── 비움마켓 Supabase (소셜/외부 인증용) ──
const authUrl = import.meta.env.VITE_AUTH_SUPABASE_URL;
const authKey = import.meta.env.VITE_AUTH_SUPABASE_ANON_KEY;

export const supabaseAuth = authUrl && authKey
  ? createClient(authUrl, authKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        storageKey: "sb-auth-biummarket",
        detectSessionInUrl: true,
      },
    })
  : null;

// ── 더브릿지 ERP Supabase (데이터 + 자체 인증) ──
const dbUrl = import.meta.env.VITE_SUPABASE_URL;
const dbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseDB = dbUrl && dbKey
  ? createClient(dbUrl, dbKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        storageKey: "sb-auth-thebridge",
        detectSessionInUrl: false,
      },
    })
  : null;

// 하위 호환용 (기존 import { supabase } 대응)
export const supabase = supabaseDB;
