import { serve } from 'https://deno.land/std@0.131.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { imageTokens } from '../_shared/tokenCosts.ts';
import { planMaxTokensForUser } from '../_shared/planMaps.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SECRET_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
const falApiKey = Deno.env.get('FAL_KEY') ?? '';
const xaiApiKey = Deno.env.get('XAI_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceKey || !openaiApiKey || !falApiKey) {
  throw new Error('SUPABASE_URL, SECRET_KEY, OPENAI_API_KEY, or FAL_KEY is not set');
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

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
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

async function callGenerateImagenFastImage(prompt: string, imageNumber: number): Promise<{ image_url: string; tokens: number }> {
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

  try {
    const { user_id, group_id, batch_number, feedback: rawFeedback } = await req.json();
    const feedback = typeof rawFeedback === 'string' ? rawFeedback.trim().slice(0, 250) : '';

    if (!user_id || !group_id || !batch_number) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id, group_id, or batch_number', code: 400 }),
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

    const { data: task, error: taskError } = await supabase
      .from('image_tasks')
      .select('*')
      .eq('user_id', finalUserId)
      .eq('group_id', group_id)
      .eq('batch_number', batch_number)
      .single();

    if (taskError || !task) {
      return new Response(
        JSON.stringify({ error: `Task not found for user_id: ${finalUserId}, group_id: ${group_id}, batch_number: ${batch_number}`, code: 404 }),
        { status: 404, headers: responseHeaders }
      );
    }

    const { data: planData, error: planError } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_used, rollover_tokens, is_legacy_plan')
      .eq('user_id', finalUserId)
      .eq('is_active', true)
      .single();

    if (planError || !planData) {
      await logError('Plan query error', planError || new Error('No plan data'));
      return new Response(
        JSON.stringify({ error: `Failed to fetch user plan for user_id: ${finalUserId}. Ensure a valid plan exists.`, code: 403 }),
        { status: 403, headers: responseHeaders }
      );
    }

    const planType = planData.plan_type || 'free';
    // Resolve legacy flag per-user; explicit boolean compare so null/undefined defaults to NEW (higher) pricing.
    const isLegacy = (planData as { is_legacy_plan?: boolean }).is_legacy_plan === true;
    const requiredTokens = imageTokens(isLegacy, task.image_model);
    const tokensRemaining = planMaxTokensForUser(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0);

    if (tokensRemaining < requiredTokens) {
      return new Response(
        JSON.stringify({
          error: `Insufficient tokens for redo. Required: ${requiredTokens}, Available: ${tokensRemaining}`,
          code: 403
        }),
        { status: 403, headers: responseHeaders }
      );
    }

    if (!task.batch || !Array.isArray(task.batch) || task.batch.length !== 1 || !task.batch[0].text) {
      await supabase
        .from('image_tasks')
        .update({
          status: 'pending',
          error: 'Invalid batch data',
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);

      return new Response(
        JSON.stringify({ error: 'Invalid batch data', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    const basePrompt = task.batch[0].text;
    const prompt = feedback ? `${basePrompt}\n\nUser feedback for revision: ${feedback}` : basePrompt;
    const imageNumber = task.batch_number;
    const sanitizedTitle = task.story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const imageFolder = `documents/${finalUserId}/${group_id}/${sanitizedTitle}_${task.folder_timestamp}`;
    const imagePath = `${imageFolder}/${imageNumber}.png`;

    // Delete the existing image
    const { error: deleteError } = await supabase.storage
      .from('stories')
      .remove([imagePath]);

    if (deleteError) {
      await logError('Failed to delete existing image', deleteError);
      await supabase
        .from('image_tasks')
        .update({
          status: 'pending',
          error: `Failed to delete existing image: ${deleteError.message}`,
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);

      return new Response(
        JSON.stringify({ error: 'Failed to delete existing image', code: 500 }),
        { status: 500, headers: responseHeaders }
      );
    }

    // Update task to redoing state with tokens reset (status remains completed_final)
    const { error: updateError } = await supabase
      .from('image_tasks')
      .update({
        redo_status: 'redoing',
        redo_started_at: new Date().toISOString(),
        progress: 0,
        error: null,
        updated_at: new Date().toISOString(),
        // DO NOT change status - it should remain 'completed_final'
      })
      .eq('id', task.id);

    if (updateError) {
      await logError('Task update error', updateError);
      return new Response(
        JSON.stringify({ error: 'Failed to update task for redo', code: 500 }),
        { status: 500, headers: responseHeaders }
      );
    }

    // If this is an ITV keyframe, mark ITV_tasks as redoing immediately
    // so the frontend spinner and resume detection work from the start
    if (task.itv === true && task.image_model !== 'flux-2-dev') {
      await supabase
        .from('ITV_tasks')
        .update({
          redo_status: { status: 'redoing', mode: 'image_and_video' },
          redo_started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', finalUserId)
        .eq('group_id', group_id)
        .eq('image_number', task.batch_number)
        .eq('tab', task.tab ?? 1);
    }

    // Handle flux-2-dev with background processing
    if (task.image_model === 'flux-2-dev') {
      // Return 202 immediately for flux processing
      const response = new Response(
        JSON.stringify({ 
          status: 'processing',
          message: 'Flux-2-dev redo processing in background',
          group_id,
          batch_number 
        }), 
        { status: 202, headers: responseHeaders }
      );

      // Process in background using EdgeRuntime.waitUntil
      EdgeRuntime.waitUntil(
        (async () => {
          try {
            // If this is an ITV keyframe, mark ITV_tasks as redoing immediately
            // so the frontend spinner and resume detection work from the start
            if (task.itv === true) {
              await supabase
                .from('ITV_tasks')
                .update({
                  redo_status: { status: 'redoing', mode: 'image_and_video' },
                  redo_started_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq('user_id', finalUserId)
                .eq('group_id', group_id)
                .eq('image_number', task.batch_number)
                .eq('tab', task.tab ?? 1);
            }

            console.log(`Background flux redo started for image ${batch_number}`);
            const result = await callGenerateFluxDevImage(prompt, imageNumber);
            // Override hardcoded LEGACY token count with canonical legacy-aware price.
            result.tokens = requiredTokens;
            console.log(`Flux redo generation completed for image ${batch_number}`);

            // Download image
            const imageResponse = await fetch(result.image_url);
            if (!imageResponse.ok) throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
            const imageData = await imageResponse.arrayBuffer();

            // Upload to storage
            const { error: uploadError } = await supabase.storage
              .from('stories')
              .upload(imagePath, imageData, { 
                contentType: 'image/png',
                upsert: true
              });

            if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

            const { data: urlData } = supabase.storage.from('stories').getPublicUrl(imagePath);
            if (!urlData?.publicUrl) throw new Error('Failed to get public URL');

            const batchContent = `Image ${imageNumber} saved to: ${urlData.publicUrl}`;

            // Update task to completed
            await supabase
              .from('image_tasks')
              .update({
                redo_status: null,
                redo_started_at: null,
                batch_output: batchContent,
                progress: 100,
                tokens: result.tokens,
                token_updated: true,
                updated_at: new Date().toISOString(),
              })
              .eq('id', task.id);

            console.log(`Background flux redo completed for image ${batch_number}`);

            // If this was an ITV keyframe image, chain into redo-ITV
            if (task.itv === true) {
              try {
                const { data: itvTask } = await supabase
                  .from('ITV_tasks')
                  .select('id, batch_number')
                  .eq('user_id', finalUserId)
                  .eq('group_id', group_id)
                  .eq('image_number', task.batch_number)
                  .eq('tab', task.tab ?? 1)
                  .maybeSingle();
                if (itvTask) {
                  await fetch(`${supabaseUrl}/functions/v1/redo-ITV`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'apikey': supabaseServiceKey,
                    },
                    body: JSON.stringify({
                      group_id,
                      batch_number: itvTask.batch_number,
                      user_id: finalUserId,
                      new_image_url: imagePath,
                      mode: 'image_and_video',
                      feedback,
                    }),
                  });
                  console.log(`Chained redo-ITV for ITV task batch ${itvTask.batch_number}`);
                }
              } catch (itvErr: any) {
                console.error('Failed to chain redo-ITV after flux image redo:', itvErr.message);
              }
            }
          } catch (error: any) {
            console.error(`Background flux redo failed for image ${batch_number}:`, error);
            await logError('Background flux redo error', error);
            await supabase
              .from('image_tasks')
              .update({ 
                redo_status: 'failed',
                error: `Flux redo failed: ${error.message}`, 
                updated_at: new Date().toISOString() 
              })
              .eq('id', task.id);
          }
        })()
      );

      return response;
    }

    // Generate new image for all other models synchronously
    let image_url: string;
    // Charge canonical legacy-aware price (requiredTokens) regardless of value the
    // model wrapper happens to return, so non-legacy users are not charged the legacy rate.
    let tokens: number = requiredTokens;
    let imageData: ArrayBuffer;

    if (task.image_model === 'imagen-4-fast') {
      const result = await callGenerateImagenFastImage(prompt, imageNumber);
      image_url = result.image_url;
    } else if (task.image_model === 'gpt-image-1-mini') {
      const result = await callGenerateGptImageMiniImage(prompt, imageNumber);
      image_url = result.image_url;
      imageData = result.imageData; // Use processed image data
    } else if (task.image_model === 'imagen-4-ultra') {
      const result = await callGenerateImagenUltraImage(prompt, imageNumber);
      image_url = result.image_url;
    } else if (task.image_model === 'flux-2-dev') {
      const result = await callGenerateFluxDevImage(prompt, imageNumber);
      image_url = result.image_url;
    } else if (task.image_model === 'grok-imagine-image') {
      const result = await callGenerateGrokImage(prompt, imageNumber);
      image_url = result.image_url;
      imageData = result.imageData;
    } else if (task.image_model === 'seedream-4.5') {
      const result = await callGenerateSeedreamImage(prompt, imageNumber);
      image_url = result.image_url;
    } else if (task.image_model === 'nano-banana-pro') {
      const result = await callGenerateNanaBananaImage(prompt, imageNumber);
      image_url = result.image_url;
    } else {
      await supabase
        .from('image_tasks')
        .update({
          status: 'pending',
          error: 'Invalid image_model',
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);

      return new Response(
        JSON.stringify({ error: 'Invalid image_model', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    // Download and upload new image (for non-GPT models) or use processed data (for GPT model)
    if (task.image_model !== 'gpt-image-1-mini' && task.image_model !== 'grok-imagine-image') {
      const imageResponse = await fetch(image_url);
      if (!imageResponse.ok) {
        await supabase
          .from('image_tasks')
          .update({
            status: 'pending',
            error: `Failed to download image: HTTP ${imageResponse.status}`,
            updated_at: new Date().toISOString(),
            tokens: 0,
            token_updated: false
          })
          .eq('id', task.id);
        throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
      }

      imageData = await imageResponse.arrayBuffer();
    }

    const { error: uploadError } = await supabase.storage
      .from('stories')
      .upload(imagePath, imageData, { 
        contentType: 'image/png',
        upsert: true  // Overwrite if file already exists
      });

    if (uploadError) {
      await supabase
        .from('image_tasks')
        .update({
          status: 'pending',
          error: `Failed to upload image: ${uploadError.message}`,
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);
      throw new Error(`Failed to upload image: ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(imagePath);
    if (!urlData?.publicUrl) {
      await supabase
        .from('image_tasks')
        .update({
          status: 'pending',
          error: 'Failed to retrieve public URL',
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);
      throw new Error('Failed to retrieve public URL');
    }

    const batchContent = `Image ${imageNumber} saved to: ${urlData.publicUrl}`;

    const { error: finalUpdateError } = await supabase
      .from('image_tasks')
      .update({
        redo_status: null,
        redo_started_at: null,
        batch_output: batchContent,
        progress: 100,
        tokens: tokens,
        token_updated: true,
        updated_at: new Date().toISOString(),
        // status remains 'completed_final' - not changed
      })
      .eq('id', task.id);

    if (finalUpdateError) {
      await logError('Final task update error', finalUpdateError);
      return new Response(
        JSON.stringify({ error: 'Failed to update task after image generation', code: 500 }),
        { status: 500, headers: responseHeaders }
      );
    }

    // If this was an ITV keyframe image, chain into redo-ITV
    if (task.itv === true) {
      try {
        const { data: itvTask } = await supabase
          .from('ITV_tasks')
          .select('id, batch_number')
          .eq('user_id', finalUserId)
          .eq('group_id', group_id)
          .eq('image_number', task.batch_number)
          .eq('tab', task.tab ?? 1)
          .maybeSingle();
        if (itvTask) {
          await fetch(`${supabaseUrl}/functions/v1/redo-ITV`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseServiceKey,
            },
            body: JSON.stringify({
              group_id,
              batch_number: itvTask.batch_number,
              user_id: finalUserId,
              new_image_url: imagePath,
              mode: 'image_and_video',
              feedback,
            }),
          });
          console.log(`Chained redo-ITV for ITV task batch ${itvTask.batch_number}`);
        }
      } catch (itvErr: any) {
        console.error('Failed to chain redo-ITV after image redo:', itvErr.message);
      }
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(
      JSON.stringify({ message: `Redo completed for image ${batch_number}`, group_id, batch_number, image_url: urlData.publicUrl, tokens }),
      { status: 200, headers: responseHeaders }
    );

  } catch (error: any) {
    await logError('Error in redo-image', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: responseHeaders }
    );
  }
});




