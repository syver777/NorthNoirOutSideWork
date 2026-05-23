import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Environment Variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is not set");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

// Initialize Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Utility Functions
function validateInputs(title: string, description: string, wordCount: number, groupId: string, userId: string): string | null {
  if (!title || typeof title !== "string" || title.trim().length === 0) return "Title is missing or invalid";
  if (!description || typeof description !== "string" || description.trim().length === 0) return "Description is missing or invalid";
  if (isNaN(wordCount) || wordCount < 200 || wordCount > 40000) return `Word count must be between 200 and 40,000. You entered: ${wordCount}`;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!groupId || !uuidRegex.test(groupId)) return `Group ID must be a valid UUID. Received: ${groupId}`;
  if (!userId || !uuidRegex.test(userId)) return `User ID must be a valid UUID. Received: ${userId}`;
  return null;
}

async function validateUserId(userId: string): Promise<string | null> {
  try {
    console.log(`Validating user_id: ${userId}`);
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .single();
    console.log(`Query result: data=${JSON.stringify(data)}, error=${JSON.stringify(error)}`);
    if (error || !data) {
      return `User ID ${userId} does not exist in profiles table`;
    }
    return null;
  } catch (err) {
    console.error("Error validating user_id:", err);
    return "Failed to validate user_id due to database error";
  }
}

// Main Handler
async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed, use POST", code: 405 }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let payload;
  try {
    if (!req.body) {
      return new Response(
        JSON.stringify({ error: "Request body is missing", code: 400 }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const contentType = req.headers.get("Content-Type");
    if (!contentType?.includes("application/json")) {
      return new Response(
        JSON.stringify({ error: "Content-Type must be application/json", code: 400 }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    payload = await req.json();
    console.log("Received payload:", JSON.stringify(payload, null, 2));
  } catch (error: any) {
    console.error("Invalid JSON payload:", error);
    return new Response(
      JSON.stringify({ error: "Invalid or malformed JSON payload", code: 400 }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { title, description, word_count: rawWordCount, group_id: rawGroupId, user_id: rawUserId, tab: rawTab } = payload;
    const wordCount = parseInt(rawWordCount?.toString(), 10);
    const groupId = rawGroupId?.toString() || crypto.randomUUID();
    const userId = rawUserId?.toString();
    const tab = rawTab ? parseInt(rawTab?.toString(), 10) : 1;

    const validationError = validateInputs(title, description, wordCount, groupId, userId);
    if (validationError) {
      return new Response(
        JSON.stringify({ error: validationError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userIdError = await validateUserId(userId);
    if (userIdError) {
      return new Response(
        JSON.stringify({ error: userIdError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Queue job in Supabase
    const { data, error } = await supabase
      .from("story_tasks")
      .insert({
        id: crypto.randomUUID(),
        user_id: userId,
        group_id: groupId,
        story_title: title,
        description,
        total_word_count: wordCount,
        status: "pending",
        tab: tab,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error("Failed to queue job:", error);
      return new Response(
        JSON.stringify({ error: "Failed to queue job", code: 500 }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ task_id: data.id, status: "queued" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Error in handler:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error", code: 500 }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server running on port ${port}`);
serve(handler, { port });
