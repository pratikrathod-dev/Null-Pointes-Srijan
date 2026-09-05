// ─────────────────────────────────────────────────────────────────────────────
//  Paste your two Supabase values here, then reload the extension.
//  Both are safe to keep in the extension: the anon key is designed to be
//  public, and row-level security is what actually stops one account reading
//  another's board.
//
//  Where to find them:  supabase.com  ->  your project
//                       Settings -> API -> Project URL and anon/public key
//
//  Full walkthrough, including the one SQL snippet to run: README, "Sync".
// ─────────────────────────────────────────────────────────────────────────────

export const SUPABASE_URL = 'https://zblhbrhkcftkqjhqesjp.supabase.co'

// Supabase dashboard -> Settings -> API -> "anon" / "public" key.
// It is a long JWT starting with "eyJ". Safe to keep here: it only ever grants
// the permissions your row-level-security policies allow.
//
// NOT the service_role key, and NOT the database password — either of those
// would hand full admin access to anyone who installs the extension.
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpibGhicmhrY2Z0a3FqaHFlc2pwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3NjI2NjgsImV4cCI6MjEwMzMzODY2OH0.OwPzy0qoSaF-GEHDCnEs1IOZ4LD0I1epoHnNVvDlOy0'

export function isConfigured() {
  return SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20
}
