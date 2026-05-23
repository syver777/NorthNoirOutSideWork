// General utility functions for VideoGenerator

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

// Format numbers for display (e.g., 1500 -> 1.5K, 2000000 -> 2.0M)
export const formatNumber = (num: number): string => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
};

// Format date string to readable format
export const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

// Sanitize file names - remove special characters
export const sanitizeFileName = (fileName: string): string => {
  // Keep only alphanumeric, spaces, hyphens, underscores, and dots
  const sanitized = fileName.replace(/[^a-zA-Z0-9\s\-_.]/g, '_');
  
  // Remove multiple consecutive underscores/spaces and trim
  return sanitized.replace(/[_\s]+/g, '_').replace(/^_+|_+$/g, '');
};

// Convert hours and minutes to total seconds
export const convertTimeToSeconds = (hours: number, minutes: number): number => {
  return (hours * 3600) + (minutes * 60);
};

// Delete user audio folder from Supabase storage
export const deleteUserAudioFolder = async (userId: string): Promise<void> => {
  try {
    const { data: files, error: listError } = await supabase.storage
      .from('video-audio')
      .list(`${userId}/`, { limit: 1000 });

    if (listError) {
      console.error('Error listing audio files:', listError);
      return;
    }

    if (files && files.length > 0) {
      const filePaths = files.map((file: any) => `${userId}/${file.name}`);
      const { error: deleteError } = await supabase.storage
        .from('video-audio')
        .remove(filePaths);

      if (deleteError) {
        console.error('Error deleting audio files:', deleteError);
      } else {
        console.log(`Successfully deleted ${filePaths.length} audio files for user ${userId}`);
      }
    }
  } catch (error) {
    console.error('Failed to delete user audio folder:', error);
  }
};

// Clean up session clone voice
export const cleanupSessionCloneVoice = async (
  sessionCloneVoiceId: string | null,
  sessionCloneVoiceFilePath: string | null,
  currentUserId: string | null
): Promise<void> => {
  if (sessionCloneVoiceId && currentUserId) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-clone-voice`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            action: 'delete',
            voice_id: sessionCloneVoiceId,
            audio_file_path: sessionCloneVoiceFilePath
          }),
        });
        
        console.log(`Cleaned up session clone voice: ${sessionCloneVoiceId}`);
      }
    } catch (error: unknown) {
      const err = error as Error;
      console.warn(`Failed to cleanup session clone voice: ${err.message}`);
    }
  }
};
