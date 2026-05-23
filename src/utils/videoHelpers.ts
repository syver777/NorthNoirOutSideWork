// Video helper utilities for VideoGenerator

import { saveAs } from 'file-saver';

export interface VideoMetadata {
  duration: number;
  size: number;
  width: number;
  height: number;
  bitrate?: number;
}

// Video metadata extraction utility
export const getVideoMetadata = (file: File): Promise<VideoMetadata> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    video.onloadedmetadata = () => {
      resolve({
        duration: video.duration,
        size: file.size,
        width: video.videoWidth,
        height: video.videoHeight,
        // Estimate bitrate: file_size_bits / duration
        bitrate: video.duration > 0 ? (file.size * 8) / video.duration : undefined
      });
      
      // Clean up
      URL.revokeObjectURL(video.src);
    };
    
    video.onerror = () => {
      URL.revokeObjectURL(video.src);
      reject(new Error('Failed to load video metadata'));
    };
    
    video.src = URL.createObjectURL(file);
  });
};

// Timeout wrapper for promises
export const withTimeout = <T,>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    )
  ]);
};

// Retry wrapper for operations
export const withRetry = async <T,>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> => {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`${operationName} attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay * attempt));
      }
    }
  }
  
  throw lastError!;
};

// Streaming download function for large files
export const handleStreamingDownload = async (
  signedUrl: string,
  fileName: string,
  docId: string,
  setDownloadProgress: (update: (prev: Record<string, number>) => Record<string, number>) => void
) => {
  try {
    const response = await fetch(signedUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch video: ${response.status}`);
    }

    const contentLength = +response.headers.get('Content-Length')!;
    const reader = response.body!.getReader();
    
    let receivedLength = 0;
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      chunks.push(value);
      receivedLength += value.length;
      
      // Update progress
      const progress = Math.round((receivedLength / contentLength) * 100);
      setDownloadProgress(prev => ({ ...prev, [docId]: progress }));
    }

    // Combine chunks and download
    const blob = new Blob(chunks, { type: 'video/mp4' });
    saveAs(blob, fileName);
    
    // Clear progress
    setDownloadProgress(prev => ({ ...prev, [docId]: 0 }));
    
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`Error in streaming download:`, error);
    throw new Error(error.message || 'Failed to download large video file');
  }
};

// Format file size for display
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

// Format duration in seconds to readable time
export const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};
