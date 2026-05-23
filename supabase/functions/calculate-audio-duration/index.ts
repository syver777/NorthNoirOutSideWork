
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];

function getCorsOrigin(req: Request): string {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
function getCorsHeaders(req: Request): Record<string, string> {
  const corsOrigin = getCorsOrigin(req);
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, content-type, apikey',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// Initialize Supabase client
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SECRET_KEY') ?? '';
const supabaseAnonKey = (Deno.env.get('PUBLIC_KEY')) ?? '';
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

interface AudioFile {
  path: string;
  url?: string;
  name?: string;
  duration?: number;
}

interface CalculateAudioDurationRequest {
  files?: AudioFile[];
  folderPath?: string; // NEW: Support folder path input
}

interface CalculateAudioDurationResponse {
  totalDuration: number;
  filesWithDurations: AudioFile[];
  error?: string;
}

/**
 * List all audio files in a Supabase storage folder
 */
async function listFilesInFolder(folderPath: string): Promise<AudioFile[]> {
  try {
    if (!supabase) {
      console.error('Supabase client not initialized');
      return [];
    }

    // Normalize folder path (remove trailing slash)
    const normalizedPath = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
    
    console.log(`📁 Listing files in folder: "${normalizedPath}"`);

    // List all files in the folder from 'stories' bucket
    // The list() function returns files in the specified directory
    const { data, error } = await supabase.storage
      .from('stories')
      .list(normalizedPath, {
        limit: 1000, // Ensure we get all files
        offset: 0,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (error) {
      console.error(`❌ Error listing files in folder ${normalizedPath}:`, error);
      return [];
    }

    console.log(`📋 Raw list response: ${data?.length || 0} items`);
    
    if (!data || data.length === 0) {
      console.log(`⚠️ No files found in folder ${normalizedPath}`);
      return [];
    }

    // Log all items found
    data.forEach((item, idx) => {
      console.log(`  [${idx}] name="${item.name}" id="${item.id || 'N/A'}"`);
    });

    // Filter for audio files and create AudioFile objects
    const audioExtensions = ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'];
    const audioFiles: AudioFile[] = [];
    
    for (const file of data) {
      const fileName = file.name.toLowerCase();
      const isAudioFile = audioExtensions.some(ext => fileName.endsWith(ext));
      
      if (isAudioFile) {
        const audioFile: AudioFile = {
          path: `${normalizedPath}/${file.name}`,
          name: file.name,
          duration: 0 // Will be calculated
        };
        audioFiles.push(audioFile);
        console.log(`  ✅ Audio file: "${file.name}" (${fileName.endsWith('.wav') ? 'WAV' : fileName.endsWith('.mp3') ? 'MP3' : 'OTHER'})`);
      } else {
        console.log(`  ⏭️ Skipping non-audio: "${file.name}"`);
      }
    }

    console.log(`✨ Found ${audioFiles.length} audio files in folder`);
    audioFiles.forEach((f, idx) => {
      console.log(`  Audio ${idx + 1}: path="${f.path}", name="${f.name}"`);
    });
    
    return audioFiles;
  } catch (error) {
    console.error(`💥 Exception listing files in folder ${folderPath}:`, error);
    return [];
  }
}

/**
 * Create a signed URL for accessing private files in Supabase storage
 */
async function createSignedUrl(filePath: string): Promise<string | null> {
  try {
    if (!supabase) {
      console.error('Supabase client not initialized');
      return null;
    }

    // Create signed URL with 1 hour expiration
    // Audio files are stored in the 'stories' bucket
    const { data, error } = await supabase.storage
      .from('stories')
      .createSignedUrl(filePath, 3600); // 1 hour

    if (error) {
      console.error(`Error creating signed URL for ${filePath}:`, error);
      return null;
    }

    if (data && data.signedUrl) {
      console.log(`✅ Created signed URL for ${filePath}`);
      return data.signedUrl;
    }

    console.error(`No signed URL in response for ${filePath}`);
    return null;
  } catch (error) {
    console.error(`Exception creating signed URL for ${filePath}:`, error);
    return null;
  }
}

/**
 * Extract duration from audio file using metadata parsing
 */
async function getAudioDuration(url: string, filePath?: string): Promise<number> {
  try {
    // If file path is provided, create a signed URL for private file access
    let fetchUrl = url;
    if (filePath) {
      const signedUrl = await createSignedUrl(filePath);
      if (signedUrl) {
        fetchUrl = signedUrl;
        console.log(`Using signed URL for ${filePath}`);
      } else {
        console.warn(`Could not create signed URL for ${filePath}, trying public URL`);
      }
    }

    // Fetch the audio file
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio file: ${response.statusText}`);
    }
    
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    console.log(`Downloaded ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`);
    
    // Parse MP3 with VBR header support (XING/VBRI)
    const duration = parseMp3DurationAccurate(new DataView(arrayBuffer));
    
    if (duration > 0) {
      console.log(`Parsed duration: ${duration.toFixed(2)}s (${(duration / 60).toFixed(2)} minutes)`);
      return duration;
    }
    
    // Fallback: estimate from file size
    const fileSizeBytes = arrayBuffer.byteLength;
    const estimatedBitrate = estimateMp3Bitrate(new DataView(arrayBuffer));
    const estimatedDuration = (fileSizeBytes * 8) / (estimatedBitrate * 1000);
    console.log(`Fallback estimation: ${estimatedDuration.toFixed(2)}s`);
    
    return estimatedDuration;
  } catch (error) {
    console.error(`Error extracting duration:`, error);
    return 0;
  }
}

/**
 * Parse MP3 duration accurately using VBR headers (XING/VBRI) or frame counting
 */
function parseMp3DurationAccurate(dataView: DataView): number {
  try {
    let offset = 0;
    
    // Skip ID3v2 tag if present
    if (dataView.getUint8(0) === 0x49 && dataView.getUint8(1) === 0x44 && dataView.getUint8(2) === 0x33) {
      const size = ((dataView.getUint8(6) & 0x7f) << 21) |
                   ((dataView.getUint8(7) & 0x7f) << 14) |
                   ((dataView.getUint8(8) & 0x7f) << 7) |
                   (dataView.getUint8(9) & 0x7f);
      offset = 10 + size;
    }
    
    // Find first MP3 frame
    while (offset < dataView.byteLength - 4) {
      if (dataView.getUint8(offset) === 0xFF && (dataView.getUint8(offset + 1) & 0xE0) === 0xE0) {
        const header = (dataView.getUint8(offset) << 24) |
                       (dataView.getUint8(offset + 1) << 16) |
                       (dataView.getUint8(offset + 2) << 8) |
                       dataView.getUint8(offset + 3);
        
        // Extract sample rate
        const sampleRateIndex = (header >> 10) & 0x03;
        const version = (header >> 19) & 0x03;
        const sampleRates = [44100, 48000, 32000];
        let sampleRate = sampleRates[sampleRateIndex] || 44100;
        if (version === 3) sampleRate /= 2; // MPEG 2
        if (version === 2) sampleRate /= 4; // MPEG 2.5
        
        // Calculate frame size
        const bitRateIndex = (header >> 12) & 0x0F;
        const paddingBit = (header >> 9) & 0x01;
        const bitRates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
        const bitRate = bitRates[bitRateIndex] * 1000;
        
        if (bitRate === 0 || sampleRate === 0) {
          offset++;
          continue;
        }
        
        const frameSize = Math.floor((144 * bitRate / sampleRate) + paddingBit);
        
        // Check for XING header (VBR) - offset varies by MPEG version and channels
        const channelMode = (header >> 6) & 0x03;
        const isMono = channelMode === 3;
        const isMPEG1 = version === 3;
        
        // Calculate correct XING offset
        let xingOffset;
        if (isMPEG1) {
          xingOffset = offset + (isMono ? 21 : 36);
        } else {
          xingOffset = offset + (isMono ? 13 : 21);
        }
        
        if (xingOffset + 120 < dataView.byteLength) {
          // Check for "Xing" or "Info" marker
          const marker = String.fromCharCode(
            dataView.getUint8(xingOffset),
            dataView.getUint8(xingOffset + 1),
            dataView.getUint8(xingOffset + 2),
            dataView.getUint8(xingOffset + 3)
          );
          
          if (marker === 'Xing' || marker === 'Info') {
            const flags = dataView.getUint32(xingOffset + 4, false);
            if (flags & 0x0001) { // Frames field is present
              const totalFrames = dataView.getUint32(xingOffset + 8, false);
              const samplesPerFrame = 1152;
              const duration = (totalFrames * samplesPerFrame) / sampleRate;
              console.log(`Found XING header: ${totalFrames} frames, ${sampleRate}Hz`);
              return duration;
            }
          }
        }
        
        // Check for VBRI header (alternative VBR format)
        const vbriOffset = offset + 36;
        if (vbriOffset + 32 < dataView.byteLength) {
          const vbriMarker = String.fromCharCode(
            dataView.getUint8(vbriOffset),
            dataView.getUint8(vbriOffset + 1),
            dataView.getUint8(vbriOffset + 2),
            dataView.getUint8(vbriOffset + 3)
          );
          
          if (vbriMarker === 'VBRI') {
            const totalFrames = dataView.getUint32(vbriOffset + 14, false);
            const samplesPerFrame = 1152;
            const duration = (totalFrames * samplesPerFrame) / sampleRate;
            console.log(`Found VBRI header: ${totalFrames} frames, ${sampleRate}Hz`);
            return duration;
          }
        }
        
        // No VBR header found, use file size estimation
        break;
      }
      offset++;
    }
    
    return 0;
  } catch (error) {
    console.error('Error parsing MP3 accurately:', error);
    return 0;
  }
}

/**
 * Estimate MP3 bitrate by sampling frame headers
 */
function estimateMp3Bitrate(dataView: DataView): number {
  const bitRates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const detectedBitrates: number[] = [];
  let offset = 0;
  
  // Skip ID3v2 tag if present
  if (dataView.getUint8(0) === 0x49 && dataView.getUint8(1) === 0x44 && dataView.getUint8(2) === 0x33) {
    const size = ((dataView.getUint8(6) & 0x7f) << 21) |
                 ((dataView.getUint8(7) & 0x7f) << 14) |
                 ((dataView.getUint8(8) & 0x7f) << 7) |
                 (dataView.getUint8(9) & 0x7f);
    offset = 10 + size;
  }
  
  // Sample up to 50 frames to detect bitrate
  let framesSampled = 0;
  const maxSamples = 50;
  
  while (offset < dataView.byteLength - 4 && framesSampled < maxSamples) {
    // Check for frame sync
    if (dataView.getUint8(offset) === 0xFF && (dataView.getUint8(offset + 1) & 0xE0) === 0xE0) {
      const header = (dataView.getUint8(offset) << 24) |
                     (dataView.getUint8(offset + 1) << 16) |
                     (dataView.getUint8(offset + 2) << 8) |
                     dataView.getUint8(offset + 3);
      
      const bitRateIndex = (header >> 12) & 0x0F;
      const bitRate = bitRates[bitRateIndex];
      
      if (bitRate > 0) {
        detectedBitrates.push(bitRate);
        framesSampled++;
      }
      
      // Skip to next potential frame (rough estimate)
      offset += 400;
    } else {
      offset++;
    }
  }
  
  // Return average bitrate, or default to 128 if detection failed
  if (detectedBitrates.length > 0) {
    const avgBitrate = Math.round(detectedBitrates.reduce((a, b) => a + b, 0) / detectedBitrates.length);
    return avgBitrate;
  }
  
  return 128; // Default to 128kbps
}

/**
 * Parse audio duration from different formats
 */
async function parseAudioDuration(arrayBuffer: ArrayBuffer, mimeType: string): Promise<number> {
  const dataView = new DataView(arrayBuffer);

  // MP3 Format
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return parseMp3Duration(dataView);
  }

  // WAV Format
  if (mimeType.includes('wav')) {
    return parseWavDuration(dataView);
  }

  // M4A/AAC Format
  if (mimeType.includes('m4a') || mimeType.includes('aac') || mimeType.includes('mp4')) {
    return parseM4aDuration(dataView);
  }

  // OGG Format
  if (mimeType.includes('ogg')) {
    return parseOggDuration(dataView);
  }

  // FLAC Format
  if (mimeType.includes('flac')) {
    return parseFlacDuration(dataView);
  }

  return 0;
}

/**
 * Parse MP3 duration
 */
function parseMp3Duration(dataView: DataView): number {
  try {
    // Look for ID3v2 tag
    let offset = 0;
    if (dataView.getUint8(0) === 0x49 && dataView.getUint8(1) === 0x44 && dataView.getUint8(2) === 0x33) {
      // ID3v2 tag present
      const size = ((dataView.getUint8(6) & 0x7f) << 21) |
                   ((dataView.getUint8(7) & 0x7f) << 14) |
                   ((dataView.getUint8(8) & 0x7f) << 7) |
                   (dataView.getUint8(9) & 0x7f);
      offset = 10 + size;
    }

    // Count frames
    let frameCount = 0;
    let sampleRate = 0;
    const maxFrames = 10000; // Limit to prevent infinite loops

    while (offset < dataView.byteLength - 4 && frameCount < maxFrames) {
      // Check for frame sync (11 bits set to 1)
      if (dataView.getUint8(offset) === 0xFF && (dataView.getUint8(offset + 1) & 0xE0) === 0xE0) {
        const header = (dataView.getUint8(offset) << 24) |
                       (dataView.getUint8(offset + 1) << 16) |
                       (dataView.getUint8(offset + 2) << 8) |
                       dataView.getUint8(offset + 3);

        // Extract sample rate
        if (frameCount === 0) {
          const sampleRateIndex = (header >> 10) & 0x03;
          const version = (header >> 19) & 0x03;
          
          const sampleRates = [44100, 48000, 32000];
          if (sampleRateIndex < 3) {
            sampleRate = sampleRates[sampleRateIndex];
            if (version === 3) sampleRate /= 2; // MPEG 2
            if (version === 2) sampleRate /= 4; // MPEG 2.5
          }
        }

        frameCount++;
        
        // Calculate frame length
        const bitRateIndex = (header >> 12) & 0x0F;
        const paddingBit = (header >> 9) & 0x01;
        
        const bitRates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
        const bitRate = bitRates[bitRateIndex] * 1000;
        
        if (bitRate === 0 || sampleRate === 0) break;
        
        const frameLength = Math.floor((144 * bitRate / sampleRate) + paddingBit);
        offset += frameLength;
      } else {
        offset++;
      }
    }

    if (frameCount > 0 && sampleRate > 0) {
      // Each frame is 1152 samples for MPEG 1
      const samplesPerFrame = 1152;
      const duration = (frameCount * samplesPerFrame) / sampleRate;
      return duration;
    }
  } catch (error) {
    console.error('Error parsing MP3:', error);
  }
  return 0;
}

/**
 * Parse WAV duration
 */
function parseWavDuration(dataView: DataView): number {
  try {
    // Check RIFF header
    if (dataView.getUint8(0) !== 0x52 || dataView.getUint8(1) !== 0x49 || 
        dataView.getUint8(2) !== 0x46 || dataView.getUint8(3) !== 0x46) {
      console.error('Invalid RIFF header');
      return 0;
    }

    // Check WAVE format
    if (dataView.getUint8(8) !== 0x57 || dataView.getUint8(9) !== 0x41 || 
        dataView.getUint8(10) !== 0x56 || dataView.getUint8(11) !== 0x45) {
      console.error('Invalid WAVE format');
      return 0;
    }

    let sampleRate = 0;
    let numChannels = 0;
    let bitsPerSample = 0;
    let dataSize = 0;

    // Find 'fmt ' chunk to get audio format details
    let offset = 12;
    while (offset < dataView.byteLength - 8) {
      const chunkId = String.fromCharCode(
        dataView.getUint8(offset),
        dataView.getUint8(offset + 1),
        dataView.getUint8(offset + 2),
        dataView.getUint8(offset + 3)
      );

      const chunkSize = dataView.getUint32(offset + 4, true);

      if (chunkId === 'fmt ') {
        // Read format details
        numChannels = dataView.getUint16(offset + 8 + 2, true); // 2 bytes for audio format, then 2 for channels
        sampleRate = dataView.getUint32(offset + 8 + 4, true);  // Then 4 bytes for sample rate
        bitsPerSample = dataView.getUint16(offset + 8 + 14, true); // Skip to bits per sample
        
        console.log(`WAV Format: ${sampleRate}Hz, ${numChannels} channels, ${bitsPerSample}-bit`);
      } else if (chunkId === 'data') {
        dataSize = dataView.getUint32(offset + 4, true);
        console.log(`Data chunk size: ${dataSize} bytes`);
      }

      offset += 8 + chunkSize;
      
      // If we have all the info we need, calculate duration
      if (sampleRate > 0 && numChannels > 0 && bitsPerSample > 0 && dataSize > 0) {
        break;
      }
    }

    // Calculate duration using the correct formula
    if (sampleRate > 0 && numChannels > 0 && bitsPerSample > 0 && dataSize > 0) {
      const bytesPerSample = bitsPerSample / 8;
      const duration = dataSize / (sampleRate * numChannels * bytesPerSample);
      console.log(`Calculated duration: ${duration.toFixed(2)}s (${(duration / 60).toFixed(2)} minutes)`);
      return duration;
    } else {
      console.error('Could not find all required WAV chunks', { sampleRate, numChannels, bitsPerSample, dataSize });
    }
  } catch (error) {
    console.error('Error parsing WAV:', error);
  }
  return 0;
}

/**
 * Parse M4A/AAC duration
 */
function parseM4aDuration(dataView: DataView): number {
  try {
    // M4A uses MP4 container format
    // Look for 'mvhd' atom which contains duration
    let offset = 0;
    
    while (offset < dataView.byteLength - 8) {
      const size = dataView.getUint32(offset, false);
      const type = String.fromCharCode(
        dataView.getUint8(offset + 4),
        dataView.getUint8(offset + 5),
        dataView.getUint8(offset + 6),
        dataView.getUint8(offset + 7)
      );

      if (type === 'mvhd') {
        const version = dataView.getUint8(offset + 8);
        let timeScale: number;
        let duration: number;

        if (version === 1) {
          timeScale = dataView.getUint32(offset + 20, false);
          duration = dataView.getUint32(offset + 28, false); // Using lower 32 bits
        } else {
          timeScale = dataView.getUint32(offset + 12, false);
          duration = dataView.getUint32(offset + 16, false);
        }

        if (timeScale > 0) {
          return duration / timeScale;
        }
      }

      if (size === 0 || size === 1) break;
      offset += size;
    }
  } catch (error) {
    console.error('Error parsing M4A:', error);
  }
  return 0;
}

/**
 * Parse OGG duration
 */
function parseOggDuration(dataView: DataView): number {
  try {
    // OGG Vorbis format
    // This is a simplified parser - full OGG parsing is complex
    // Look for the last granule position
    
    // Estimate based on file size (rough approximation)
    // Typical OGG bitrate is around 128 kbps
    const fileSizeBytes = dataView.byteLength;
    const estimatedDuration = (fileSizeBytes * 8) / (128 * 1000);
    
    return estimatedDuration;
  } catch (error) {
    console.error('Error parsing OGG:', error);
  }
  return 0;
}

/**
 * Parse FLAC duration
 */
function parseFlacDuration(dataView: DataView): number {
  try {
    // Check fLaC signature
    if (dataView.getUint8(0) !== 0x66 || dataView.getUint8(1) !== 0x4C ||
        dataView.getUint8(2) !== 0x61 || dataView.getUint8(3) !== 0x43) {
      return 0;
    }

    // Read STREAMINFO block
    let offset = 4;
    const blockType = dataView.getUint8(offset) & 0x7F;
    const blockLength = (dataView.getUint8(offset + 1) << 16) |
                        (dataView.getUint8(offset + 2) << 8) |
                        dataView.getUint8(offset + 3);

    if (blockType === 0) { // STREAMINFO
      offset += 4;
      const sampleRate = (dataView.getUint8(offset + 10) << 12) |
                         (dataView.getUint8(offset + 11) << 4) |
                         ((dataView.getUint8(offset + 12) & 0xF0) >> 4);
      
      // Total samples (36 bits)
      const totalSamples = ((dataView.getUint8(offset + 13) & 0x0F) << 32) |
                           (dataView.getUint8(offset + 14) << 24) |
                           (dataView.getUint8(offset + 15) << 16) |
                           (dataView.getUint8(offset + 16) << 8) |
                           dataView.getUint8(offset + 17);

      if (sampleRate > 0) {
        return totalSamples / sampleRate;
      }
    }
  } catch (error) {
    console.error('Error parsing FLAC:', error);
  }
  return 0;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!token) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 401
    }      );
    }

    // authToken resolved above (Bearer or apikey)
    // Accept service role key, anon key, or valid JWT
    const serviceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
    const secretKey = Deno.env.get('SECRET_KEY') ?? '';
    if (token !== serviceRoleKey && token !== secretKey) {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(token);
      if (_authErr || !_authUser) {
        return new Response(
          JSON.stringify({ error: 'Invalid authorization token' }),
          { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 403
          }
        );
      }
    }

    // Parse request body safely
    const text = await req.text();
    if (!text || text.trim() === '') {
      return new Response(
        JSON.stringify({ 
          error: 'Empty request body',
          totalDuration: 0,
          filesWithDurations: []
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400
        }
      );
    }

    const { files, folderPath }: CalculateAudioDurationRequest = JSON.parse(text);

    console.log(`🔍 Request received - folderPath: "${folderPath || 'none'}", files: ${files?.length || 0}`);

    // Handle folder path input - list all files in folder
    let audioFiles: AudioFile[] = [];
    if (folderPath) {
      console.log(`📂 Processing folder: "${folderPath}"`);
      audioFiles = await listFilesInFolder(folderPath);
      
      if (audioFiles.length === 0) {
        console.error(`❌ No audio files found in folder: "${folderPath}"`);
        return new Response(
          JSON.stringify({ 
            error: `No audio files found in folder: ${folderPath}`,
            totalDuration: 0,
            filesWithDurations: []
          }),
          { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400
          }
        );
      }
      console.log(`✅ Retrieved ${audioFiles.length} files from folder`);
    } else if (files && Array.isArray(files)) {
      console.log(`📋 Using provided files array: ${files.length} files`);
      
      // CRITICAL FIX: Detect if files array contains folder paths and expand them
      const expandedFiles: AudioFile[] = [];
      
      for (const file of files) {
        // Check if this is actually a folder path (no extension, name is undefined/empty)
        const hasExtension = file.path && /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.path);
        const isLikelyFolder = !hasExtension && (!file.name || file.name === 'undefined');
        
        if (isLikelyFolder) {
          console.log(`🔍 Detected folder path in files array: "${file.path}"`);
          console.log(`   Listing files in this folder...`);
          
          const folderFiles = await listFilesInFolder(file.path);
          if (folderFiles.length > 0) {
            console.log(`   ✅ Found ${folderFiles.length} audio files in folder`);
            expandedFiles.push(...folderFiles);
          } else {
            console.warn(`   ⚠️ No audio files found in folder "${file.path}"`);
          }
        } else {
          // It's a real file, keep it as-is
          expandedFiles.push(file);
        }
      }
      
      audioFiles = expandedFiles;
      console.log(`✅ After expansion: ${audioFiles.length} total audio files`);
    } else {
      return new Response(
        JSON.stringify({ 
          error: 'No audio files or folder path provided',
          totalDuration: 0,
          filesWithDurations: []
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400
        }
      );
    }

    // Separate WAV and MP3/other files
    const wavFiles: AudioFile[] = [];
    const mp3Files: AudioFile[] = [];
    
    console.log(`🔀 Separating files by type...`);
    for (const file of audioFiles) {
      const fileName = (file.name || file.path.split('/').pop() || '').toLowerCase();
      console.log(`  Checking file: "${file.name}" (path: "${file.path}")`);
      
      if (fileName.endsWith('.wav')) {
        wavFiles.push(file);
        console.log(`    → WAV file`);
      } else {
        mp3Files.push(file);
        console.log(`    → MP3/Other file`);
      }
    }

    console.log(`📊 Total files: ${audioFiles.length}, WAV: ${wavFiles.length}, MP3/Other: ${mp3Files.length}`);

    // Process WAV files locally and MP3 files via Cloud Function
    const allProcessedFiles: AudioFile[] = [];
    let totalDuration = 0;

    // Check if all files are WAV - if so, handle locally; otherwise delegate to Cloud Function for MP3s
    const allFilesAreWav = mp3Files.length === 0 && wavFiles.length > 0;

    // Process MP3/other files via Cloud Function if any exist
    if (mp3Files.length > 0) {
      console.log(`☁️ Processing ${mp3Files.length} MP3/other files via Cloud Function`);
      console.log(`  Files to send:`, mp3Files.map(f => ({ name: f.name, path: f.path })));
      
      const cloudFunctionUrl = 'https://us-central1-story-script-ai.cloudfunctions.net/calculate-audio-duration';
      const cloudFunctionResponse = await fetch(cloudFunctionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
        },
        body: JSON.stringify({ files: mp3Files }),
      });

      if (!cloudFunctionResponse.ok) {
        const errorText = await cloudFunctionResponse.text();
        console.error(`❌ Cloud Function failed: HTTP ${cloudFunctionResponse.status}`, errorText);
        throw new Error(`Cloud Function failed: HTTP ${cloudFunctionResponse.status}`);
      }

      const result = await cloudFunctionResponse.json();
      console.log(`✅ Cloud Function response:`, result);
      
      // Add MP3 files to results
      allProcessedFiles.push(...(result.filesWithDurations || []));
      totalDuration += result.totalDuration || 0;
      
      console.log(`☁️ Cloud Function processed ${result.filesWithDurations?.length || 0} files, duration: ${result.totalDuration}s`);
    }

    // Process WAV files locally if any exist
    if (wavFiles.length > 0) {
      console.log(`🎵 Processing ${wavFiles.length} WAV files locally`);
      
      for (const file of wavFiles) {
        if (!file.url && !file.path) {
          console.warn(`⚠️ Skipping file without URL or path: ${file.path}`);
          continue;
        }

        console.log(`🔊 Calculating duration for WAV: "${file.name}" (path: "${file.path}")`);
        
        // For WAV files, fetch and parse directly
        let duration = 0;
        try {
          // Always create signed URL if path is provided (stories bucket is private)
          // This matches the Python function behavior
          let fetchUrl = '';
          if (file.path) {
            const signedUrl = await createSignedUrl(file.path);
            if (signedUrl) {
              fetchUrl = signedUrl;
              console.log(`  ✅ Created signed URL for WAV file`);
            } else {
              console.error(`  ❌ Failed to create signed URL for ${file.path}`);
              continue;
            }
          } else if (file.url) {
            // Fallback to provided URL if no path
            fetchUrl = file.url;
          }

          // Fetch the WAV file
          const response = await fetch(fetchUrl);
          if (!response.ok) {
            console.error(`  ❌ Failed to fetch WAV file: HTTP ${response.status}`);
            continue;
          }

          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          console.log(`  📥 Downloaded ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`);

          // Parse WAV duration directly
          const dataView = new DataView(arrayBuffer);
          duration = parseWavDuration(dataView);
          console.log(`  ⏱️ Duration: ${duration.toFixed(2)}s`);
        } catch (error) {
          console.error(`  ❌ Error processing WAV file ${file.name}:`, error);
          duration = 0;
        }
        
        const processedFile = {
          ...file,
          duration,
          name: file.name || file.path.split('/').pop() || 'unknown'
        };
        
        allProcessedFiles.push(processedFile);
        totalDuration += duration;
      }
      
      // Store TOTAL duration in database for the folder (not individual files)
      // For audio folders, the file_path in story_documents is the folder path, not individual file paths
      if (supabase && wavFiles.length > 0 && totalDuration > 0) {
        try {
          // Extract folder path from the first file (remove filename)
          const firstFilePath = wavFiles[0].path;
          const folderPath = firstFilePath.substring(0, firstFilePath.lastIndexOf('/'));
          
          console.log(`📁 Updating folder row with total duration: ${folderPath}`);
          
          const { error: updateError } = await supabase
            .from('story_documents')
            .update({ audio_duration: totalDuration })
            .eq('file_path', folderPath);
          
          if (updateError) {
            console.warn(`⚠️ Could not update folder duration in database for ${folderPath}:`, updateError);
          } else {
            console.log(`  💾 Stored total duration ${totalDuration}s for folder ${folderPath}`);
          }
        } catch (dbError) {
          console.warn(`⚠️ Database error for folder:`, dbError);
        }
      }
    }

    // Sort files by name for consistent ordering
    console.log(`🔄 Sorting ${allProcessedFiles.length} processed files...`);
    allProcessedFiles.sort((a, b) => {
      const nameA = a.name || a.path.split('/').pop() || '';
      const nameB = b.name || b.path.split('/').pop() || '';
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });

    console.log(`✅ Total duration: ${totalDuration}s (${(totalDuration / 60).toFixed(2)} minutes)`);
    console.log(`✅ Total files processed: ${allProcessedFiles.length}`);
    allProcessedFiles.forEach((f, idx) => {
      console.log(`  [${idx + 1}] "${f.name}": ${f.duration}s`);
    });

    // NOTE: Individual file durations are already stored above (lines 871-877)
    // No need to update with total duration here, as that would incorrectly
    // overwrite individual durations for uploaded audio files

    const response: CalculateAudioDurationResponse = {
      totalDuration,
      filesWithDurations: allProcessedFiles
    };

    console.log(`📤 Returning response with ${allProcessedFiles.length} files`);

    return new Response(
      JSON.stringify(response),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error) {
    console.error('Error calculating audio duration:', error);
    
    return new Response(
      JSON.stringify({
        error: error.message || 'Internal server error',
        totalDuration: 0,
        filesWithDurations: []
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});



