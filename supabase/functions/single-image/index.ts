import { serve } from 'https://deno.land/std@0.131.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { v4 as uuidv4 } from 'https://esm.sh/uuid@9.0.0';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { itvTokensPerSecond, imageTokens } from '../_shared/tokenCosts.ts';
import { planMaxTokensForUser } from '../_shared/planMaps.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SECRET_KEY') ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
const falApiKey = Deno.env.get('FAL_KEY') ?? '';
const xaiApiKey = Deno.env.get('XAI_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceKey || !deepseekApiKey || !openaiApiKey || !falApiKey) {
  throw new Error('Missing SUPABASE_URL, SECRET_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, or FAL_KEY');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const planMaxTokens: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 125000000,
};

// ITV token rates are resolved per-user via tokenCosts.ts (legacy users
// keep historical rates; new users hit the calibrated NEW_ITV_* map).
// Image rates are resolved the same way via imageTokens(isLegacy, model).

async function logError(message: string, error: any, context: object = {}) {
  console.error(`${message}:`, error, context);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        details: error.message || JSON.stringify(error),
        context: JSON.stringify(context),
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

async function rewritePromptWithDeepSeek(prompt: string): Promise<string> {
  const systemPrompt = `You are an expert visual storyteller. Rewrite the following image prompt to ensure it fully complies with Google's Imagen-4 Generative AI Prohibited Use Policy. Remove or alter any elements that could include or imply: sexually explicit content, nudity, child sexual abuse material, graphic or excessive violence, depictions of self-harm, promotion of dangerous or illegal activities, hateful or harassing content targeting protected groups, extremist or terrorist imagery, misleading or deceptive representations, impersonations of real individuals, non-consensual or intimate depictions, private or personally identifiable information, intellectual property violations (such as copyrighted logos or trademarked designs), or spam and phishing-related material. Preserve the visual style, tone, and overall concept, maintaining the original artistic mood, composition, and atmosphere while ensuring it is respectful, safe, lawful, and aligns with responsible AI image generation standards. Return only the rewritten prompt.`;
  const userPrompt = `Original prompt: ${prompt}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 4000,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error: HTTP ${response.status} - ${errorText}`);
    }

    let jsonOutput = (await response.json()).choices[0].message.content.trim();
    if (jsonOutput.startsWith('```')) jsonOutput = jsonOutput.replace(/```(json)?/g, '').trim();
    return jsonOutput;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('DeepSeek API request timed out');
    }
    throw error;
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

async function callGenerateImagenFastImage(prompt: string, imageNumber: number): Promise<{ image_url: string; tokens: number }> {
  const retryDelays = [10000, 20000, 30000, 40000, 50000];
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      console.log(`[Imagen4-Fast] Attempt ${attempt + 1}/5 - Submitting to fal-ai...`);

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
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < 4) {
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
          console.log(`[Imagen4-Fast] Generation completed successfully`);
          return { image_url, tokens: 14000 };
        } else if (status === 'FAILED') {
          throw new Error(`Generation failed: ${statusData.error || 'Unknown error'}`);
        }
      }

      if (attempt < 4) {
        console.log('[Imagen4-Fast] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (attempt < 4 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[Imagen4-Fast] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate imagen-4-fast image after 5 attempts');
}

async function callGenerateGptImageMiniImage(prompt: string, imageNumber: number): Promise<{ image_url: string; tokens: number; imageData: ArrayBuffer }> {
  const retryDelays = [10000, 20000, 30000, 40000, 50000];
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image.";

  for (let attempt = 0; attempt < 5; attempt++) {
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
        if ([429, 500, 502, 503, 504].some(code => response.status === code) && attempt < 4) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      if (!result.data || !Array.isArray(result.data) || result.data.length === 0) {
        if (attempt < 4) {
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

      // Create a blob URL for the return (though we'll use the processed data for upload)
      const blob = new Blob([processedImageData], { type: 'image/png' });
      const imageUrl = URL.createObjectURL(blob);

      return { image_url: imageUrl, tokens: 30000, imageData: processedImageData };
    } catch (error: any) {
      if (attempt < 4 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate gpt-image-1-mini image after 5 attempts');
}

async function callGenerateGrokImage(prompt: string, _imageNumber: number): Promise<{ image_url: string; tokens: number; imageData: ArrayBuffer }> {
  const retryDelays = [10000, 20000, 30000, 40000, 50000];
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
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
        if ([429, 500, 502, 503, 504].some(code => response.status === code) && attempt < 4) {
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
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      } else if (inlineUrl) {
        const imgResp = await fetch(inlineUrl);
        if (!imgResp.ok) throw new Error(`Failed to fetch grok image url: HTTP ${imgResp.status}`);
        bytes = new Uint8Array(await imgResp.arrayBuffer());
      } else {
        throw new Error('No image data in xAI response');
      }

      const processedImageData = await cropTo16x9(bytes.buffer);
      const blob = new Blob([processedImageData], { type: 'image/png' });
      const imageUrl = URL.createObjectURL(blob);

      return { image_url: imageUrl, tokens: 16000, imageData: processedImageData };
    } catch (error: any) {
      if (attempt < 4 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate grok-imagine-image after 5 attempts');
}

async function callGenerateImagenUltraImage(prompt: string, imageNumber: number): Promise<{ image_url: string; tokens: number }> {
  const retryDelays = [10000, 20000, 30000, 40000, 50000];
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      console.log(`[Imagen4-Ultra] Attempt ${attempt + 1}/5 - Submitting to fal-ai...`);

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
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < 4) {
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

      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/imagen4/preview/ultra/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/imagen4/preview/ultra/requests/${requestId}`;
      const maxPolls = 60;

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

      if (attempt < 4) {
        console.log('[Imagen4-Ultra] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error;
      }
      if (attempt < 4 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate imagen-4-ultra image after 5 attempts');
}

async function callGenerateFluxDevImage(prompt: string, imageNumber: number): Promise<{ image_url: string; tokens: number }> {
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

async function callGenerateSeedreamImage(prompt: string, imageNumber: number): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Seedream-4.5] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

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

      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image/requests/${requestId}`;
      const maxPolls = 60;

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
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate seedream-4.5 image after 5 attempts');
}

async function callGenerateNanaBananaImage(prompt: string, imageNumber: number): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[NanaBananaPro] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

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

      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${requestId}`;
      const maxPolls = 60;

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
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate nano-banana-pro image after 5 attempts');
}

serve(async (req: Request) => {
  const responseHeaders = { ...getCorsHeaders(req), 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 360000;

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: responseHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', code: 405 }),
      { status: 405, headers: responseHeaders }
    );
  }

  let requestBody: any;
  try {
    requestBody = await req.json();
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body', code: 400 }),
      { status: 400, headers: responseHeaders }
    );
  }

  try {
    const { user_id, prompt, image_style, group_id, story_title, image_model, tab,
            itv, video_model: itv_video_model, video_duration: itv_video_duration, audio_clip: itv_audio_clip } = requestBody;
    // Append the visual style to the prompt so the image generator uses it
    const styledPrompt = (image_style && typeof image_style === 'string' && image_style.trim())
      ? `${prompt.trim()} ${image_style.trim()}`
      : prompt;
    const tabNumber = typeof tab === 'number' ? tab : 1; // Default to tab 1
    const isITV = itv === true;

    if (!user_id || !prompt || !group_id || !story_title || !image_model) {
      await logError('Missing required fields', new Error('Invalid input'), { user_id, group_id, story_title, image_model, tab: tabNumber });
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id, prompt, group_id, story_title, or image_model', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    if (!['imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'].includes(image_model)) {
      await logError('Invalid image_model', new Error('Invalid image_model'), { user_id, group_id, image_model });
      return new Response(
        JSON.stringify({ error: 'Invalid image_model. Must be one of: imagen-4-fast, gpt-image-1-mini, imagen-4-ultra, flux-2-dev, grok-imagine-image, seedream-4.5, nano-banana-pro', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 401 }),
        { status: 401, headers: responseHeaders }
      );
    }
    const finalUserId = auth.isServiceRole ? user_id : auth.userId;

    const { data: planData, error: planError } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_used, rollover_tokens, is_legacy_plan')
      .eq('user_id', finalUserId)
      .eq('is_active', true)
      .single();

    if (planError || !planData) {
      await logError('Plan query error', planError || new Error('No plan data'), { user_id: finalUserId });
      return new Response(
        JSON.stringify({ error: `Failed to fetch user plan for user_id: ${finalUserId}. Ensure a valid plan exists.`, code: 403 }),
        { status: 403, headers: responseHeaders }
      );
    }

    const planType = planData.plan_type || 'free';
    const isLegacy = planData.is_legacy_plan !== false;
    const requiredTokens = imageTokens(isLegacy, image_model);
    const tokensRemaining = planMaxTokensForUser(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0);

    if (tokensRemaining < requiredTokens) {
      await logError('Insufficient tokens', new Error(`Required: ${requiredTokens}, Available: ${tokensRemaining}`), { user_id: finalUserId });
      return new Response(
        JSON.stringify({
          error: `Insufficient tokens for single image generation. Required: ${requiredTokens}, Available: ${tokensRemaining}`,
          code: 403
        }),
        { status: 403, headers: responseHeaders }
      );
    }

    // When used as the first step of a single-ITV generation, also verify combined balance
    if (isITV && itv_video_model && itv_video_duration != null) {
      const videoTPS = itvTokensPerSecond(isLegacy, itv_video_model, !!itv_audio_clip);
      const videoTokens = Math.round(itv_video_duration * videoTPS);
      if (tokensRemaining < requiredTokens + videoTokens) {
        return new Response(
          JSON.stringify({
            error: `Insufficient tokens for single ITV generation. Required: ${requiredTokens + videoTokens}, Available: ${tokensRemaining}`,
            code: 403
          }),
          { status: 403, headers: responseHeaders }
        );
      }
    }

    const folderTimestamp = new Date().toISOString().replace(/[-:T.]/g, '');
    const sanitizedTitle = story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const imageFolder = `documents/${finalUserId}/${group_id}/${sanitizedTitle}_${folderTimestamp}`;
    const imagePath = `${imageFolder}/1.png`;

    const taskData = {
      user_id: finalUserId,
      group_id,
      story_title,
      batch: [{ text: prompt }],
      total_batches: 1,
      batch_number: 1,
      total_prompts: 1,
      status: 'running',
      progress: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      single_image: true,
      folder_timestamp: folderTimestamp,
      tokens: 0,
      token_updated: false,
      settings: {},
      version: 0,
      is_corrected: false,
      image_model,
      tab: tabNumber,
    };

    const { data: task, error: taskInsertError } = await supabase
      .from('image_tasks')
      .insert(taskData)
      .select()
      .single();

    if (taskInsertError || !task) {
      await logError('Task insert error', taskInsertError || new Error('No task data'), { user_id: finalUserId, group_id, taskData });
      return new Response(
        JSON.stringify({ error: `Failed to create single image task: ${taskInsertError?.message || 'Unknown error'}`, code: 500 }),
        { status: 500, headers: responseHeaders }
      );
    }

    // If this is an ITV request, create the ITV_tasks row immediately so the frontend can poll it
    let itvTaskId: string | null = null;
    if (isITV && itv_video_model && itv_video_duration != null) {
      itvTaskId = crypto.randomUUID();
      const { error: itvInsertErr } = await supabase.from('ITV_tasks').insert({
        id: itvTaskId,
        user_id: finalUserId,
        group_id,
        story_title: `Single ITV: ${story_title}`,
        batch_number: 1,
        total_batches: 1,
        total_prompts: 1,
        status: 'pending',
        progress: 0,
        version: 0,
        video_model: itv_video_model,
        video_duration: itv_video_duration,
        audio_clip: itv_audio_clip ?? false,
        image_model,
        tab: tabNumber,
        single_itv: true,
        folder_timestamp: folderTimestamp,
        batch: [{ prompt }],
        tokens: 0,
        token_updated: false,
        settings: { image_task_id: task.id },
        is_corrected: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (itvInsertErr) {
        console.error('[single-image] ITV_tasks insert error:', itvInsertErr.message);
        // Non-fatal — clear so we don't fire single-ITV
        itvTaskId = null;
      } else {
        console.log(`[single-image] Created ITV_tasks row ${itvTaskId} for task ${task.id}`);
      }
    }

    // For flux-2-dev model, return 202 immediately and process in background
    if (image_model === 'flux-2-dev') {
      // Start background processing with EdgeRuntime.waitUntil
      req.signal.addEventListener('abort', () => {
        console.log('Request aborted, but background task will continue');
      });
      
      (async () => {
        try {
          console.log(`[Background] Starting flux-2-dev processing for single image task ${task.id}`);
          
          // Generate the image
          const imageResult = await callGenerateFluxDevImage(styledPrompt, 1);
          const image_url = imageResult.image_url;
          // Use centralized per-user cost (legacy vs new) instead of generator's hardcoded value
          const tokens = requiredTokens;
          
          console.log(`[Background] Flux image generated, downloading from ${image_url}`);
          
          // Download the image
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          const imageResponse = await fetch(image_url, { signal: controller.signal });
          clearTimeout(timeoutId);
          
          if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);
          const imageData = await imageResponse.arrayBuffer();
          
          if (imageData.byteLength === 0) {
            throw new Error('Downloaded image is empty (0 bytes)');
          }
          
          console.log(`[Background] Image downloaded (${imageData.byteLength} bytes), uploading to storage`);
          
          // Upload to storage
          const { error: uploadError } = await supabase.storage
            .from('stories')
            .upload(imagePath, imageData, { contentType: 'image/png' });
          
          if (uploadError) throw uploadError;
          
          // Get public URL
          const { data: urlData } = supabase.storage.from('stories').getPublicUrl(imagePath);
          if (!urlData?.publicUrl) throw new Error('Failed to get public URL');
          
          const batchContent = `Image 1 saved to: ${urlData.publicUrl}`;
          
          // Update task to completed
          const { error: finalUpdateError } = await supabase
            .from('image_tasks')
            .update({
              status: 'completed_final',
              batch_output: batchContent,
              progress: 100,
              tokens: tokens,
              token_updated: true,
              updated_at: new Date().toISOString(),
            })
            .eq('id', task.id);
          
          if (finalUpdateError) throw finalUpdateError;

          // If this is a single-ITV request, chain to single-ITV
          if (isITV && itvTaskId) {
            await supabase.from('ITV_tasks').update({
              image_url: urlData.publicUrl,
              updated_at: new Date().toISOString(),
            }).eq('id', itvTaskId);
            fetch(`${supabaseUrl}/functions/v1/single-ITV`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceKey,},
              body: JSON.stringify({ single_itv_init: true, task_id: itvTaskId }),
            }).catch(err => console.error('[Background] Failed to fire single-ITV:', err));
          }
          
          console.log(`[Background] Single image task ${task.id} completed successfully`);
        } catch (error) {
          console.error(`[Background] Error processing flux single image for task ${task.id}:`, error);
          await logError('[Background] Single image flux processing error', error, { user_id: finalUserId, group_id, task_id: task.id });
          
          // Update task to error status
          await supabase
            .from('image_tasks')
            .update({
              status: 'error',
              error: `Background processing failed: ${error.message}`,
              updated_at: new Date().toISOString(),
              tokens: 0,
              token_updated: false
            })
            .eq('id', task.id);
        }
      })();
      
      // Return 202 immediately
      return new Response(
        JSON.stringify({ 
          message: isITV ? 'Single ITV generation started' : 'Flux-2-dev single image processing started in background (4-5 minutes)',
          task_id: isITV ? itvTaskId : task.id,
          image_task_id: task.id,
          group_id 
        }),
        { status: 202, headers: responseHeaders }
      );
    }

    // For non-flux models, continue with synchronous processing
    let image_url: string;
    let tokens = 0;
    let imageData: ArrayBuffer;
    let attempt = 0;
    const maxAttempts = 2;
    let currentPrompt = styledPrompt;

    while (attempt < maxAttempts) {
      try {
        if (attempt > 0) {
          console.log(`Rewriting prompt for attempt ${attempt + 1}`);
          const rewrittenPrompt = await rewritePromptWithDeepSeek(styledPrompt);
          const { error: updateError } = await supabase
            .from('image_tasks')
            .update({
              batch: [{ text: rewrittenPrompt }],
              updated_at: new Date().toISOString(),
            })
            .eq('id', task.id);

          if (updateError) {
            await logError(`Failed to update batch for task ${task.id}`, updateError, { user_id: finalUserId, group_id });
          }
          currentPrompt = rewrittenPrompt;
        }

        if (image_model === 'imagen-4-fast') {
          const imageResult = await callGenerateImagenFastImage(currentPrompt, 1);
          image_url = imageResult.image_url;
          tokens = imageResult.tokens;
        } else if (image_model === 'gpt-image-1-mini') {
          const imageResult = await callGenerateGptImageMiniImage(currentPrompt, 1);
          image_url = imageResult.image_url;
          tokens = imageResult.tokens;
          imageData = imageResult.imageData; // Use processed image data
        } else if (image_model === 'imagen-4-ultra') {
          const imageResult = await callGenerateImagenUltraImage(currentPrompt, 1);
          image_url = imageResult.image_url;
          tokens = imageResult.tokens;
        } else if (image_model === 'flux-2-dev') {
          const imageResult = await callGenerateFluxDevImage(currentPrompt, 1);
          image_url = imageResult.image_url;
          tokens = imageResult.tokens;
        } else if (image_model === 'grok-imagine-image') {
          const imageResult = await callGenerateGrokImage(currentPrompt, 1);
          image_url = imageResult.image_url;
          tokens = imageResult.tokens;
          imageData = imageResult.imageData;
        } else if (image_model === 'seedream-4.5') {
          const imageResult = await callGenerateSeedreamImage(currentPrompt, 1);
          image_url = imageResult.image_url;
          tokens = imageResult.tokens;
        } else if (image_model === 'nano-banana-pro') {
          const imageResult = await callGenerateNanaBananaImage(currentPrompt, 1);
          image_url = imageResult.image_url;
          tokens = imageResult.tokens;
        }
        // Override generator's hardcoded tokens with centralized per-user cost
        tokens = requiredTokens;
      } catch (error) {
        await logError('Image generation error', error, { user_id: finalUserId, group_id, prompt: currentPrompt });
        await supabase
          .from('image_tasks')
          .update({
            status: 'error',
            error: `Image generation failed: ${error.message}`,
            updated_at: new Date().toISOString(),
            tokens: 0,
            token_updated: false
          })
          .eq('id', task.id);
        throw error;
      }

      // For non-GPT models, download the image
      if (image_model !== 'gpt-image-1-mini' && image_model !== 'grok-imagine-image') {
        try {
          console.log(`Fetching image from ${image_url}`);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          const imageResponse = await fetch(image_url, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);

          imageData = await imageResponse.arrayBuffer();

          if (imageData.byteLength === 0 && attempt < maxAttempts - 1) {
            await logError('Empty image file detected', new Error('Image file is 0 bytes'), { user_id: finalUserId, group_id, image_url });
            attempt++;
            continue;
          } else if (imageData.byteLength === 0) {
            await logError('Redone image is still empty', new Error('Image file is 0 bytes after redo'), { user_id: finalUserId, group_id, image_url });
            await supabase
              .from('image_tasks')
              .update({
                status: 'error',
                error: 'Redone image is still empty',
                updated_at: new Date().toISOString(),
                tokens: 0,
                token_updated: false
              })
              .eq('id', task.id);
            throw new Error('Redone image is still empty');
          }

          break;
        } catch (error) {
          if (error.name === 'AbortError') {
            error = new Error('Image download timed out');
          }
          await logError('Image download error', error, { user_id: finalUserId, group_id, image_url });
          await supabase
            .from('image_tasks')
            .update({
              status: 'error',
              error: `Failed to download image: ${error.message}`,
              updated_at: new Date().toISOString(),
              tokens: 0,
              token_updated: false
            })
            .eq('id', task.id);
          throw error;
        }
      } else {
        // For GPT model, we already have the processed image data
        break;
      }
    }

    try {
      const { error: uploadError } = await supabase.storage
        .from('stories')
        .upload(imagePath, imageData, { contentType: 'image/png' });

      if (uploadError) throw uploadError;
    } catch (error) {
      await logError('Image upload error', error, { user_id: finalUserId, group_id, image_path: imagePath });
      await supabase
        .from('image_tasks')
        .update({
          status: 'error',
          error: `Failed to upload image: ${error.message}`,
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);
      throw error;
    }

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(imagePath);
    if (!urlData?.publicUrl) {
      await logError('Public URL error', new Error('No public URL'), { user_id: finalUserId, group_id, image_path: imagePath });
      await supabase
        .from('image_tasks')
        .update({
          status: 'error',
          error: 'Failed to retrieve public URL',
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);
      throw new Error('Failed to retrieve public URL');
    }

    const batchContent = `Image 1 saved to: ${urlData.publicUrl}`;

    const { error: finalUpdateError } = await supabase
      .from('image_tasks')
      .update({
        status: 'completed_final',
        batch_output: batchContent,
        progress: 100,
        tokens: tokens,
        token_updated: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    if (finalUpdateError) {
      await logError('Final task update error', finalUpdateError, { user_id: finalUserId, group_id, task_id: task.id });
      return new Response(
        JSON.stringify({ error: `Failed to update task after image generation: ${finalUpdateError.message}`, code: 500 }),
        { status: 500, headers: responseHeaders }
      );
    }

    // If this is a single-ITV request, chain to single-ITV
    if (isITV && itvTaskId) {
      await supabase.from('ITV_tasks').update({
        image_url: urlData.publicUrl,
        updated_at: new Date().toISOString(),
      }).eq('id', itvTaskId);
      // Fire single-ITV asynchronously (do not await — return immediately)
      fetch(`${supabaseUrl}/functions/v1/single-ITV`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseServiceKey,},
        body: JSON.stringify({ single_itv_init: true, task_id: itvTaskId }),
      }).catch(err => console.error('[single-image] Failed to fire single-ITV:', err));

      return new Response(
        JSON.stringify({ task_id: itvTaskId, image_task_id: task.id, group_id }),
        { status: 202, headers: responseHeaders }
      );
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(
      JSON.stringify({ message: 'Single image generation completed', group_id, image_url: urlData.publicUrl, tokens }),
      { status: 200, headers: responseHeaders }
    );

  } catch (error: any) {
    await logError('Error in single-image', error, { request: requestBody });
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: responseHeaders }
    );
  }
});



