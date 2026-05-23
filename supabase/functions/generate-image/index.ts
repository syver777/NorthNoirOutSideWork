import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
import { verifyAuth } from '../_shared/utils.ts';
import { getIsLegacyPlan, imageTokens } from '../_shared/tokenCosts.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = (Deno.env.get('PUBLIC_KEY')) ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
const falApiKey = Deno.env.get('FAL_KEY') ?? '';
const xaiApiKey = Deno.env.get('XAI_API_KEY') ?? '';

if (!supabaseUrl || !supabaseKey || !openaiApiKey || !supabaseServiceRoleKey || !falApiKey) {
  throw new Error('SUPABASE_URL, PUBLIC_KEY, SECRET_KEY, OPENAI_API_KEY, or FAL_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        error_message: error.message || JSON.stringify(error),
        details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

async function cropTo16x9(imageData: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    console.log('Starting image crop to 16:9...');
    
    // Decode the image from the buffer (this is the key fix)
    const image = await Image.decode(new Uint8Array(imageData));
    console.log(`Original image dimensions: ${image.width}x${image.height}`);
    
    // Calculate 16:9 crop dimensions
    const targetRatio = 16 / 9;
    const currentRatio = image.width / image.height;
    
    // If already close to 16:9, return original
    if (Math.abs(currentRatio - targetRatio) < 0.01) {
      console.log('Image already 16:9, no cropping needed');
      return imageData;
    }
    
    // Center crop to 16:9
    const targetHeight = Math.floor(image.width / targetRatio);
    const top = Math.floor((image.height - targetHeight) / 2);
    
    console.log(`Cropping to: ${image.width}x${targetHeight}, top offset: ${top}`);
    
    // Crop the image
    const cropped = image.crop(0, top, image.width, targetHeight);
    
    // Resize to standard HD (1920x1080) for consistent output
    const resized = cropped.resize(1920, 1080, Image.RESIZE_LANCZOS);
    console.log(`Final image dimensions: 1920x1080`);
    
    // Encode back to PNG
    const processedImageData = await resized.encode();
    
    console.log('Image processing completed successfully');
    return processedImageData.buffer;
  } catch (error) {
    console.error('Error processing image:', error);
    // Return original image data if processing fails
    return imageData;
  }
}

interface RequestBody {
  prompt: string;
  image_number: number;
  image_model: string;
  task_id?: string;
  // Forwarded by service-role callers (process-image, etc.) so we can resolve
  // the actual user's is_legacy_plan flag rather than defaulting to legacy.
  user_id?: string;
}

function validateInputs(data: RequestBody): string | null {
  if (!data.prompt || typeof data.prompt !== 'string' || data.prompt.trim().length === 0) return 'Missing or invalid prompt';
  if (typeof data.image_number !== 'number' || data.image_number < 1) return 'Missing or invalid image_number';
  if (!data.image_model || typeof data.image_model !== 'string') return 'Missing or invalid image_model';
  if (!['imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'].includes(data.image_model)) return 'Invalid image_model. Must be one of: imagen-4-fast, gpt-image-1-mini, imagen-4-ultra, flux-2-dev, grok-imagine-image, seedream-4.5, nano-banana-pro';
  return null;
}

async function generateImagenFastImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Imagen4-Fast] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      // Step 1: Submit to fal-ai queue
      const submitResponse = await fetch('https://queue.fal.run/fal-ai/imagen4/preview/fast', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          aspect_ratio: '16:9',
          num_images: 1,
          output_format: 'png',
          safety_tolerance: '4',
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[Imagen4-Fast] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Imagen4-Fast] Request queued with ID: ${requestId}`);

      // Step 2: Poll status URL, then fetch result when complete
      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/imagen4/preview/fast/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/imagen4/preview/fast/requests/${requestId}`;
      console.log(`[Imagen4-Fast] responseUrl: ${responseUrl}`);
      const maxPolls = 60;

      // Initial wait before first poll
      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[Imagen4-Fast] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[Imagen4-Fast] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          // First check if result is embedded inline in the status response
          const inlineImage = statusData.output?.images?.[0]?.url || statusData.images?.[0]?.url;
          if (inlineImage) {
            console.log(`[Imagen4-Fast] Result found inline in status response`);
            return { image_url: inlineImage, tokens: 14000 };
          }
          console.log(`[Imagen4-Fast] Fetching result from: ${responseUrl}`);
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            const errBody = await resultResponse.text().catch(() => '');
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status} body: ${errBody}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[Imagen4-Fast] Generation completed successfully`);
          return { image_url, tokens: 14000 };
        } else if (status === 'FAILED') {
          throw new Error(`Generation failed: ${statusData.error || 'Unknown error'}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[Imagen4-Fast] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[Imagen4-Fast] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate imagen-4-fast image after 5 attempts');
}

async function generateGptImageMiniImage(prompt: string): Promise<{ image_url: string; tokens: number; imageData?: ArrayBuffer }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image.";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 360000);

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-image-1-mini",
          prompt: modifiedPrompt,
          n: 1,
          quality: "high",
          size: "1536x1024"
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        
        // Check for OpenAI safety violations
        if (response.status === 400 && errorText.includes('safety_violations')) {
          const safetyError = new Error(`Content filtered by safety system: ${errorText}`);
          safetyError.name = 'ModelUnavailableError';
          throw safetyError;
        }
        
        if ([429, 500, 502, 503, 504].some(code => response.status === code) && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      if (!result.data || !Array.isArray(result.data) || result.data.length === 0) {
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error('No image data in response');
      }

      // OpenAI returns base64 data by default
      const imageB64 = result.data[0].b64_json;
      if (!imageB64) {
        throw new Error('No base64 image data in response');
      }

      // Convert base64 to ArrayBuffer
      const binaryString = atob(imageB64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Process image to 16:9 aspect ratio
      const processedImageData = await cropTo16x9(bytes.buffer);

      // Create a data URL for the return
      const uint8Array = new Uint8Array(processedImageData);
      let binaryString2 = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binaryString2 += String.fromCharCode(uint8Array[i]);
      }
      const base64String = btoa(binaryString2);
      const imageUrl = `data:image/png;base64,${base64String}`;

      return { image_url: imageUrl, tokens: 30000, imageData: processedImageData };
    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error; // Re-throw model unavailable errors immediately
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate gpt-image-1-mini image after 5 attempts');
}

async function generateImagenUltraImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Imagen4-Ultra] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      // Step 1: Submit to fal-ai queue
      const submitResponse = await fetch('https://queue.fal.run/fal-ai/imagen4/preview/ultra', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          aspect_ratio: '16:9',
          num_images: 1,
          output_format: 'png',
          safety_tolerance: '4',
          resolution: '1K',
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[Imagen4-Ultra] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Imagen4-Ultra] Request queued with ID: ${requestId}`);

      // Step 2: Poll status URL, then fetch result when complete
      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/imagen4/preview/ultra/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/imagen4/preview/ultra/requests/${requestId}`;
      const maxPolls = 60;

      // Initial wait before first poll
      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[Imagen4-Ultra] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[Imagen4-Ultra] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[Imagen4-Ultra] Generation completed successfully`);
          return { image_url, tokens: 42000 };
        } else if (status === 'FAILED') {
          const errorMsg = statusData.error || 'Unknown error';
          if (errorMsg.includes('safety') || errorMsg.includes('filtered') || errorMsg.includes('blocked')) {
            const modelError = new Error(`Content filtered: ${errorMsg}`);
            modelError.name = 'ModelUnavailableError';
            throw modelError;
          }
          throw new Error(`Generation failed: ${errorMsg}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[Imagen4-Ultra] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error;
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[Imagen4-Ultra] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate imagen-4-ultra image after 5 attempts');
}

async function generateFluxDevImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000]; // 10s, 20s, 30s, 40s, 50s

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Flux-2] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);
      
      // Step 1: Submit the request to fal-ai queue
      const submitResponse = await fetch('https://queue.fal.run/fal-ai/flux-2', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          image_size: "landscape_16_9",
          num_inference_steps: 28,
          num_images: 1,
          guidance_scale: 2.5,
          enable_safety_checker: false,
          output_format: "png"
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;
      
      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Flux-2] Request queued with ID: ${requestId}`);

      // Step 2: Poll for results using the result endpoint directly
      const resultUrl = `https://queue.fal.run/fal-ai/flux-2/requests/${requestId}`;
      const maxPolls = 60; // Poll for up to 120 seconds
      
      // Wait 5 seconds before first poll to give the queue time to process
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Wait 30 seconds before first poll to allow fal-ai to process the request
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between subsequent polls
        }
        
        const resultResponse = await fetch(resultUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Key ${falApiKey}`,
          },
        });

        if (!resultResponse.ok) {
          // Log the actual error for debugging
          const errorText = await resultResponse.text().catch(() => 'Unable to read error');
          console.log(`[Flux-2] Poll ${poll + 1} failed with status ${resultResponse.status}: ${errorText}`);
          
          // 404 means not ready yet, keep polling
          if (resultResponse.status === 404) {
            continue;
          }
          // 400/422 might mean bad request or not ready, keep trying for a bit
          if ((resultResponse.status === 400 || resultResponse.status === 422) && poll < 10) {
            continue;
          }
          // Other errors or too many 400/422s, give up on this poll cycle but continue
          if (poll < maxPolls - 1) {
            continue;
          }
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${resultResponse.status}`);
        }

        const result = await resultResponse.json();
        console.log(`[Flux-2] Poll ${poll + 1} response:`, JSON.stringify(result).substring(0, 200));
        const status = result.status;
        
        if (status === 'COMPLETED' || !status) {
          // If no status field or COMPLETED, check for images
          console.log(`[Flux-2] Generation completed successfully`);
          
          // Extract image URL from fal-ai response
          let image_url = null;
          if (result.images && Array.isArray(result.images) && result.images.length > 0) {
            image_url = result.images[0].url;
          }

          if (!image_url) {
            console.log(`[Flux-2] No images in result yet, continuing to poll...`);
            continue;
          }

          return { image_url, tokens: 7000 };
        } else if (status === 'FAILED') {
          throw new Error(`Generation failed: ${result.error || 'Unknown error'}`);
        }
        
        // Still IN_PROGRESS or IN_QUEUE, continue polling
        console.log(`[Flux-2] Poll ${poll + 1}: Status ${status}, continuing...`);
      }

      // If we exhausted polls, retry the whole request
      if (attempt < maxRetries - 1) {
        console.log('Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      
      throw new Error('Polling timeout after maximum attempts');
      
    } catch (error: any) {
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate flux-2-dev image after 5 attempts');
}

async function generateSeedreamImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Seedream-4.5] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      // Step 1: Submit to fal-ai queue
      const submitResponse = await fetch('https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          image_size: { width: 2560, height: 1440 },
          num_images: 1,
          enable_safety_checker: false,
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[Seedream-4.5] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Seedream-4.5] Request queued with ID: ${requestId}`);

      // Step 2: Poll status URL, then fetch result when complete
      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image/requests/${requestId}`;
      const maxPolls = 60;

      // Initial wait before first poll
      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[Seedream-4.5] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[Seedream-4.5] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[Seedream-4.5] Generation completed successfully`);
          return { image_url, tokens: 35000 };
        } else if (status === 'FAILED') {
          const errorMsg = statusData.error || 'Unknown error';
          if (errorMsg.includes('safety') || errorMsg.includes('filtered') || errorMsg.includes('blocked')) {
            const modelError = new Error(`Content filtered: ${errorMsg}`);
            modelError.name = 'ModelUnavailableError';
            throw modelError;
          }
          throw new Error(`Generation failed: ${errorMsg}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[Seedream-4.5] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error;
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[Seedream-4.5] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate seedream-4.5 image after 5 attempts');
}

async function generateNanaBananaImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[NanaBananaPro] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      // Step 1: Submit to fal-ai queue
      const submitResponse = await fetch('https://queue.fal.run/fal-ai/nano-banana-pro', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          aspect_ratio: '16:9',
          num_images: 1,
          output_format: 'png',
          safety_tolerance: '4',
          resolution: '1K',
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[NanaBananaPro] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[NanaBananaPro] Request queued with ID: ${requestId}`);

      // Step 2: Poll status URL, then fetch result when complete
      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${requestId}`;
      const maxPolls = 60;

      // Initial wait before first poll
      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[NanaBananaPro] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[NanaBananaPro] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[NanaBananaPro] Generation completed successfully`);
          return { image_url, tokens: 100000 };
        } else if (status === 'FAILED') {
          const errorMsg = statusData.error || 'Unknown error';
          if (errorMsg.includes('safety') || errorMsg.includes('filtered') || errorMsg.includes('blocked')) {
            const modelError = new Error(`Content filtered: ${errorMsg}`);
            modelError.name = 'ModelUnavailableError';
            throw modelError;
          }
          throw new Error(`Generation failed: ${errorMsg}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[NanaBananaPro] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error;
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[NanaBananaPro] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate nano-banana-pro image after 5 attempts');
}

async function generateGrokImage(prompt: string): Promise<{ image_url: string; tokens: number; imageData?: ArrayBuffer }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Grok-Imagine] Attempt ${attempt + 1}/${maxRetries} - Calling xAI...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 360000);

      const response = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${xaiApiKey}`,
        },
        body: JSON.stringify({
          model: 'grok-imagine-image',
          prompt: modifiedPrompt,
          n: 1,
          response_format: 'b64_json',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();

        // Treat content moderation rejections as model-unavailable so callers can fall back to empty-redo
        if (response.status === 400 && (errorText.toLowerCase().includes('moderation') || errorText.toLowerCase().includes('safety') || errorText.toLowerCase().includes('content'))) {
          const safetyError = new Error(`Content filtered by xAI: ${errorText}`);
          safetyError.name = 'ModelUnavailableError';
          throw safetyError;
        }

        if ([429, 500, 502, 503, 504].some(code => response.status === code) && attempt < maxRetries - 1) {
          console.log(`[Grok-Imagine] HTTP ${response.status}, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const item = result?.data?.[0];
      const imageB64 = item?.b64_json;
      const inlineUrl = item?.url;

      let bytes: Uint8Array;
      if (imageB64) {
        const binaryString = atob(imageB64);
        bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
      } else if (inlineUrl) {
        const imgResp = await fetch(inlineUrl);
        if (!imgResp.ok) throw new Error(`Failed to fetch grok image url: HTTP ${imgResp.status}`);
        const ab = await imgResp.arrayBuffer();
        bytes = new Uint8Array(ab);
      } else {
        throw new Error('No image data in xAI response');
      }

      // Process image to 16:9 aspect ratio for consistency with other models
      const processedImageData = await cropTo16x9(bytes.buffer);

      const u8 = new Uint8Array(processedImageData);
      let binStr = '';
      for (let i = 0; i < u8.length; i++) binStr += String.fromCharCode(u8[i]);
      const base64String = btoa(binStr);
      const imageUrl = `data:image/png;base64,${base64String}`;

      console.log('[Grok-Imagine] Generation completed successfully');
      return { image_url: imageUrl, tokens: 16000, imageData: processedImageData };
    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') throw error;
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        console.log(`[Grok-Imagine] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate grok-imagine-image after 5 attempts');
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000;

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const payload: RequestBody = await req.json();
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { prompt, image_number, image_model, task_id } = payload;

    // Handle all models synchronously
    let result: { image_url: string; tokens: number; imageData?: ArrayBuffer } | null = null;

    try {
      if (image_model === 'imagen-4-fast') {
        result = await generateImagenFastImage(prompt);
      } else if (image_model === 'gpt-image-1-mini') {
        result = await generateGptImageMiniImage(prompt);
      } else if (image_model === 'imagen-4-ultra') {
        result = await generateImagenUltraImage(prompt);
      } else if (image_model === 'flux-2-dev') {
        result = await generateFluxDevImage(prompt);
      } else if (image_model === 'grok-imagine-image') {
        result = await generateGrokImage(prompt);
      } else if (image_model === 'seedream-4.5') {
        result = await generateSeedreamImage(prompt);
      } else if (image_model === 'nano-banana-pro') {
        result = await generateNanaBananaImage(prompt);
      } else {
        throw new Error('Invalid image_model');
      }

      // Plan-restructure: override the per-model token cost with the
      // value from tokenCosts.ts. Legacy users keep historical rates;
      // new users use the calibrated map. When invoked via service-role
      // (auth.userId is empty), trust user_id from the payload — otherwise
      // getIsLegacyPlan('') would default to legacy and undercharge.
      if (result) {
        const billingUserId = auth.isServiceRole && payload.user_id ? payload.user_id : auth.userId;
        const isLegacy = await getIsLegacyPlan(billingUserId);
        result.tokens = imageTokens(isLegacy, image_model);
      }
    } catch (error: any) {
      // Check if this is a model unavailable error and we have a task_id
      if ((error.name === 'ModelUnavailableError' || 
           error.message.includes('cannot be generated') || 
           error.message.includes('try use another model') ||
           error.message.includes('Content is filtered') ||
           error.message.includes('filtered by content moderation') ||
           error.message.includes('sensitive information') ||
           error.message.includes('Support codes:') ||
           error.message.includes('HTTP 500') ||
           error.message.includes('value_error') ||
           error.message.includes('HTTP 422')) && task_id) {
        
        console.log('Model unavailable or content filtered, calling empty-redo directly from generate-image');
        
        try {
          const emptyRedoPayload = {
            prompt,
            image_number,
            image_model,
            task_id
          };

          const response = await fetch(`${supabaseUrl}/functions/v1/empty-redo`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceRoleKey,
            },
            body: JSON.stringify(emptyRedoPayload),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Empty-redo failed: HTTP ${response.status}: ${errorText}`);
          }

          const emptyRedoResult = await response.json();
          console.log('Successfully called empty-redo from generate-image');
          
          return new Response(JSON.stringify(emptyRedoResult), { 
            status: 200, 
            headers: responseHeaders 
          });
          
        } catch (emptyRedoError: any) {
          console.error('Empty-redo also failed:', emptyRedoError);
          await logError('Empty-redo failed after model unavailable', emptyRedoError);
          // Fall through to throw original error
        }
      }
      
      // If we get here, either it's not a model unavailable error, or empty-redo failed
      throw error;
    }

    // Ensure result was assigned
    if (!result) {
      throw new Error('Image generation failed: no result returned');
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in generate-image', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});




