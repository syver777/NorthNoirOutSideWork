/** Ambient types for Supabase Edge Functions (Deno runtime). IDE-only; deployed on Deno. */
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

declare module 'npm:@supabase/supabase-js@2' {
  export * from '@supabase/supabase-js';
}
