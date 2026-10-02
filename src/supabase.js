import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Si faltan las variables, la app funciona solo con el almacenamiento del navegador.
export const sb = url && key ? createClient(url, key) : null;
