import * as tus from 'tus-js-client';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// Use direct storage hostname for better performance
const TUS_ENDPOINT = `https://yilrqukialrbdzydvwmt.storage.supabase.co/storage/v1/upload/resumable`;

// File size threshold for TUS vs regular upload (6MB)
const TUS_THRESHOLD = 6 * 1024 * 1024;

export interface TusUploadOptions {
  file: File;
  bucket: string;
  path: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
  onError?: (error: Error) => void;
  onSuccess?: (publicUrl: string) => void;
  contentType?: string;
}

export interface TusUploadResult {
  success: boolean;
  publicUrl?: string;
  error?: string;
}

/**
 * Upload file using TUS resumable upload or regular upload based on file size
 */
export const uploadWithTus = async (options: TusUploadOptions): Promise<TusUploadResult> => {
  const { file, bucket, path, onProgress, onError, onSuccess, contentType } = options;

  try {
    // Get current session for authentication
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw new Error('Authentication required');
    }

    // Use regular upload for small files, TUS for large files
    if (file.size < TUS_THRESHOLD) {
      return await uploadRegular(options, session.access_token);
    } else {
      return await uploadTus(options, session.access_token);
    }
  } catch (error: any) {
    const errorMessage = error.message || 'Upload failed';
    if (onError) onError(new Error(errorMessage));
    return { success: false, error: errorMessage };
  }
};

/**
 * Regular Supabase upload for small files
 */
const uploadRegular = async (options: TusUploadOptions, accessToken: string): Promise<TusUploadResult> => {
  const { file, bucket, path, onProgress, onSuccess, contentType } = options;

  try {
    // Simulate progress for regular uploads
    if (onProgress) {
      onProgress(0, file.size);
    }

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(path, file, {
        contentType: contentType || file.type,
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Complete progress
    if (onProgress) {
      onProgress(file.size, file.size);
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
    const publicUrl = urlData.publicUrl;

    if (onSuccess) onSuccess(publicUrl);
    return { success: true, publicUrl };

  } catch (error: any) {
    throw new Error(error.message || 'Regular upload failed');
  }
};

/**
 * TUS resumable upload for large files
 */
const uploadTus = async (options: TusUploadOptions, accessToken: string): Promise<TusUploadResult> => {
  const { file, bucket, path, onProgress, onSuccess, contentType } = options;

  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: TUS_ENDPOINT,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      chunkSize: 6 * 1024 * 1024, // 6MB chunks
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey: import.meta.env.SUPABASE_PUBLISHABLE_KEY,
        'x-upsert': 'true'
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: contentType || file.type,
        cacheControl: '3600'
      },
      onError: (error) => {
        console.error('TUS upload error:', error);
        const errorMessage = error.message || 'TUS upload failed';
        reject(new Error(errorMessage));
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        if (onProgress) {
          onProgress(bytesUploaded, bytesTotal);
        }
      },
      onSuccess: () => {
        console.log('TUS upload completed successfully');
        
        // Get public URL after successful upload
        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);
        const publicUrl = urlData.publicUrl;
        
        if (onSuccess) onSuccess(publicUrl);
        resolve({ success: true, publicUrl });
      }
    });

    // Start the upload
    upload.start();
  });
};

/**
 * Cancel an ongoing TUS upload
 */
export const cancelTusUpload = (upload: tus.Upload) => {
  if (upload) {
    upload.abort();
  }
};

/**
 * Helper to format upload progress
 */
export const formatUploadProgress = (bytesUploaded: number, bytesTotal: number) => {
  const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
  const uploadedMB = (bytesUploaded / (1024 * 1024)).toFixed(1);
  const totalMB = (bytesTotal / (1024 * 1024)).toFixed(1);
  
  return {
    percentage,
    uploadedMB,
    totalMB,
    formattedString: `${uploadedMB}MB / ${totalMB}MB (${percentage}%)`
  };
};

/**
 * Helper to estimate upload time remaining
 */
export const estimateTimeRemaining = (bytesUploaded: number, bytesTotal: number, startTime: number) => {
  if (bytesUploaded === 0) return null;
  
  const elapsed = Date.now() - startTime;
  const rate = bytesUploaded / elapsed; // bytes per ms
  const remaining = (bytesTotal - bytesUploaded) / rate; // ms remaining
  
  const seconds = Math.round(remaining / 1000);
  
  if (seconds < 60) return `${seconds}s remaining`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m remaining`;
  return `${Math.round(seconds / 3600)}h remaining`;
};

