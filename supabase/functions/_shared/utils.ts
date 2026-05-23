const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';
const SECRET_KEY = Deno.env.get('SECRET_KEY') ?? '';
// Prefer new opaque secret key when present; fall back to legacy service_role JWT during cutover.
const PRIVILEGED_KEY = SECRET_KEY || SERVICE_ROLE_KEY;
import { createClient } from 'npm:@supabase/supabase-js@2';

export const supabase = createClient(SUPABASE_URL, PRIVILEGED_KEY);

export const MAX_WORDS_PER_BATCH = 500;
export const TOKEN_PER_WORD = 1.33;
export const INPUT_CREDIT_PER_MILLION_TOKENS = 0.27;
export const OUTPUT_CREDIT_PER_MILLION_TOKENS = 1.10;

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.ceil(words * TOKEN_PER_WORD);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

export function calculateCredits(inputTokens: number, outputTokens: number): number {
  const inputCredits = (inputTokens / 1_000_000) * INPUT_CREDIT_PER_MILLION_TOKENS;
  const outputCredits = (outputTokens / 1_000_000) * OUTPUT_CREDIT_PER_MILLION_TOKENS;
  return inputCredits + outputCredits;
}

export async function checkTokenAvailability(userId: string, inputTokens: number, outputTokens: number): Promise<{ canUseTokens: boolean; reason?: string }> {
  try {
    const tokensToAdd = Math.round(inputTokens * 0.25 + outputTokens);
    
    const { data: userPlan, error } = await supabase
      .from('user_plans')
      .select('tokens_used, tokens_allocated, rollover_tokens')
      .eq('user_id', userId)
      .single();
    
    if (error) {
      console.error(`Failed to fetch user plan for ${userId}:`, error);
      return { canUseTokens: false, reason: 'Failed to fetch user plan' };
    }
    
    if (!userPlan) {
      console.error(`No user plan found for ${userId}`);
      return { canUseTokens: false, reason: 'No user plan found' };
    }
    
    const newTotal = userPlan.tokens_used + tokensToAdd;
    const totalAvailable = userPlan.tokens_allocated + (userPlan.rollover_tokens || 0);
    const canUse = newTotal <= totalAvailable;
    
    if (!canUse) {
      console.warn(`Token limit would be exceeded for user ${userId}: ${newTotal} > ${totalAvailable} (adding ${tokensToAdd})`);
      return { 
        canUseTokens: false, 
        reason: `Token limit would be exceeded: ${newTotal} > ${totalAvailable}` 
      };
    }
    
    return { canUseTokens: true };
  } catch (error: any) {
    console.error(`Error checking token availability for user ${userId}:`, error);
    return { canUseTokens: false, reason: `Error checking tokens: ${error.message}` };
  }
}

export async function withRetry<T>(operation: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (
        ['429', '500', '503'].some(code => error.message.includes(code)) ||
        error.message.toLowerCase().includes('overloaded') ||
        error.name === 'ConnectionError'
      ) {
        if (attempt < retries) {
          console.log(`Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError;
}

export async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const errorMessage = error?.message || error?.toString() || 'Unknown error';
    const errorDetails = error?.stack || JSON.stringify(error) || 'No additional details';
    
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message: message || 'Unknown error',
        error_message: errorMessage,
        details: errorDetails,
        created_at: new Date().toISOString(),
      });
    if (dbError) {
      console.error('Failed to log error to database:', dbError);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

export function determineBatchCount(outlineText: string): number {
  const lines = outlineText.replace(/\r\n|\r/g, '\n').trim().split('\n');
  const batchPlanStart = lines.findIndex(line => /^\s*Batch Plan:\s*$/.test(line));
  if (batchPlanStart === -1) {
    const chapterLines = lines.filter(line => /^\d+\.\s+/.test(line));
    return chapterLines.length;
  }
  const batchLines = lines.slice(batchPlanStart + 1).filter(line => line.startsWith('- Batch'));
  return batchLines.length;
}

export async function verifyAuth(req: Request): Promise<{ userId: string; isServiceRole: boolean } | null> {
  // Accept the privileged token from either the Authorization: Bearer header
  // or the apikey header (gateway no longer enforces apikey under --no-verify-jwt).
  const authHeader = req.headers.get('Authorization') ?? '';
  const apikeyHeader = req.headers.get('apikey') ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = bearer || apikeyHeader;
  if (!token) return null;

  const serviceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
  const secretKey = Deno.env.get('SECRET_KEY') ?? '';
  if ((secretKey && token === secretKey) || (serviceRoleKey && token === serviceRoleKey)) {
    return { userId: '', isServiceRole: true };
  }
  // Only Bearer tokens make sense as user JWTs; apikey header is never a user JWT.
  if (!bearer) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(bearer);
    if (error || !user) return null;
    return { userId: user.id, isServiceRole: false };
  } catch {
    return null;
  }
}
