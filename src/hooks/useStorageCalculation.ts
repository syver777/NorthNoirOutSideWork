import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

export const useStorageCalculation = () => {
  const [storageUsed, setStorageUsed] = useState<number | null>(null);

  const calculateFileSize = async (doc: any) => {
    try {
      const { data: { session: _scSession } } = await supabase.auth.getSession();
      const response = await fetch('https://yilrqukialrbdzydvwmt.supabase.co/functions/v1/calculate-file-size', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_scSession?.access_token || ''}`,
          'apikey': import.meta.env.SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          id: doc.id,
          file_path: doc.file_path,
          version: doc.version,
        }),
      });
      if (!response.ok) {
        throw new Error(`Failed to calculate file_size for ${doc.id}: HTTP ${response.status}`);
      }
      const { file_size } = await response.json();
      if (file_size != null) {
        // Only update story_documents table
        await supabase
          .from('story_documents')
          .update({ file_size })
          .eq('id', doc.id);
        return file_size;
      }
      return doc.file_size || 0;
    } catch (err: any) {
      console.error(`Error calculating file_size for ${doc.id}:`, err);
      return doc.file_size || 0;
    }
  };

  const calculateStorageUsed = async (userId: string) => {
    try {
      // Fetch only from story_documents table
      const { data: storyDocs, error } = await supabase
        .from('story_documents')
        .select('*, file_size')
        .eq('user_id', userId);

      if (error) throw error;

      const allDocs = storyDocs || [];

      if (allDocs.length === 0) {
        setStorageUsed(0);
        return 0;
      }

      // Calculate file sizes for documents that don't have them
      for (const doc of allDocs) {
        if (doc.file_size == null || doc.file_size === 0) {
          await calculateFileSize(doc);
        }
      }

      // Recalculate total after updates
      let totalSize = 0;
      totalSize = allDocs.reduce((sum, doc) => {
        if (doc.file_size != null && doc.file_size > 0) {
          return sum + doc.file_size;
        }
        const estimatedSize = (doc.word_count ?? 0) * 1.5;
        return sum + estimatedSize;
      }, 0);

      const totalSizeMB = totalSize / (1024 * 1024);
      const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? 0.1 : Number(totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2));
      
      setStorageUsed(formattedSize);
      return formattedSize;
    } catch (err: any) {
      console.error('Error calculating storage:', err);
      setStorageUsed(0);
      return 0;
    }
  };

  return { storageUsed, calculateStorageUsed, setStorageUsed };
};

