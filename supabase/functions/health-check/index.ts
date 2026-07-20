// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

console.log('health-check function initialized');

// Platform JWT verification is disabled; the handler validates a configured publishable key.
export default {
  fetch: withSupabase({ auth: 'publishable' }, async (req, ctx) => {
    if (req.method !== 'GET') return Response.json({ ok: false }, { status: 405 });
    const { data, error } = await ctx.supabaseAdmin.rpc('get_model_readiness');
    if (error) return Response.json({ ok: false, database: false }, { status: 503 });

    return Response.json({
      ok: true,
      database: true,
      checked_at: new Date().toISOString(),
      model_readiness: { eligible_to_train: data?.eligible_to_train === true },
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/health-check' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
