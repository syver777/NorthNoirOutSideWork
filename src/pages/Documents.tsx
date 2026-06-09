import React, { useEffect, useState } from 'react';
import { Download, FileText, Trash2, Image, Folder, Music, Film, Eye, Pencil, AlertTriangle, X, Circle, CheckCircle2 } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import DashboardLayout from '../components/DashboardLayout';
import LargeVideoDownloadModal from '../components/LargeVideoDownloadModal';
import AudioPlayer from '../components/AudioPlayer';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { getStorageLimitFormatted, getStorageLimitMB } from '../utils/storageHelpers';
import { sanitizeFileName } from '../utils/videoGeneratorUtils';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface StoryDocument {
  id: string;
  title: string;
  is_corrected: boolean;
  is_prompted: boolean;
  created_at: string;
  file_path: string;
  word_count: number | null;
  version?: number;
  variant?: number;
  group_id?: string;
  file_size?: number | null;
  description?: string;
  tab?: number;
}

interface GroupedDocuments {
  [groupId: string]: {
    original: StoryDocument | null;
    relatedDocuments: StoryDocument[];
  };
}

type DeleteScenario = 'simple-delete' | 'story-generator-only' | 'video-completed' | 'video-active' | 'image-prompts-only' | 'image-generator-completed' | 'image-generator-active' | 'image-folder-completed' | 'image-folder-active' | 'audio-tts-completed' | 'audio-tts-active' | 'video-file-completed' | 'ttv-prompts-completed' | 'ttv-prompts-active' | 'ttv-folder-completed' | 'ttv-folder-active' | 'itv-image-prompts-completed' | 'itv-image-prompts-active' | 'itv-image-folder-completed' | 'itv-image-folder-active' | 'itv-video-prompts-completed' | 'itv-video-prompts-active' | 'itv-folder-completed' | 'itv-folder-active';

interface VideoTaskStatus {
  id: string;
  overall_status: string;
  story_status: string;
  image_prompt_status: string;
  image_generation_status: string;
  audio_status: string;
  video_creation_status: string;
  doc_id: string | null;
}

interface DeleteConfirmModalState {
  doc: StoryDocument;
  userId: string;
  groupId: string;
  tab: number;
  scenario: DeleteScenario;
  videoTasks?: VideoTaskStatus[];
  imageTasksCompleted?: boolean;
  imageFolderMode?: 'new-prompts' | 'use-prompts';
}

export default function Documents() {
  const [documents, setDocuments] = useState<GroupedDocuments>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<'all' | 'final-video'>('all');
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  const [userPlan, setUserPlan] = useState<string>('free');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<StoryDocument | null>(null);
  const [folderImages, setFolderImages] = useState<string[]>([]);
  const [isVideoFolderModalOpen, setIsVideoFolderModalOpen] = useState(false);
  const [selectedVideoFolder, setSelectedVideoFolder] = useState<StoryDocument | null>(null);
  const [folderVideos, setFolderVideos] = useState<{ name: string; url: string; size: number }[]>([]);
  const [loadingVideoFolder, setLoadingVideoFolder] = useState(false);
  const [downloadingVideos, setDownloadingVideos] = useState<{ [key: string]: boolean }>({});
  const [downloadingZips, setDownloadingZips] = useState<{ [docId: string]: boolean }>({});
  const [downloadingImages, setDownloadingImages] = useState<{ [index: number]: boolean }>({});
  const [downloadingAudios, setDownloadingAudios] = useState<{ [docId: string]: boolean }>({});
  const [downloadProgress, setDownloadProgress] = useState<{ [docId: string]: number }>({});
  const [zipFolderProgress, setZipFolderProgress] = useState<{ [docId: string]: number }>({});
  const [deletingDocs, setDeletingDocs] = useState<{ [docId: string]: boolean }>({});
  const [checkingDelete, setCheckingDelete] = useState<{ [docId: string]: boolean }>({});
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<DeleteConfirmModalState | null>(null);
  const [confirmDeleting, setConfirmDeleting] = useState(false);
  // Bulk-selection / mark-all state
  const [markedDocIds, setMarkedDocIds] = useState<Set<string>>(new Set());
  const [bulkResolving, setBulkResolving] = useState(false);
  const [bulkDeleteModal, setBulkDeleteModal] = useState<{
    states: DeleteConfirmModalState[]; // ordered bottom-to-top
    worstScenario: DeleteScenario;
  } | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  // Large file download modal state
  const [largeVideoDownloadModal, setLargeVideoDownloadModal] = useState<{
    fileName: string;
    fileSizeBytes: number;
    signedUrl: string;
  } | null>(null);

  const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50 MB — show info modal before downloading

  // Text file preview modal state
  const [textPreviewModal, setTextPreviewModal] = useState<{
    doc: StoryDocument;
    content: string;
    isEditing: boolean;
    editedContent: string;
    saving: boolean;
  } | null>(null);
  const [textPreviewLoading, setTextPreviewLoading] = useState(false);

  // Audio preview modal state
  const [audioPreviewModal, setAudioPreviewModal] = useState<{
    doc: StoryDocument;
    audioFiles: { name: string; url: string; filePath: string }[];
  } | null>(null);
  const [audioPreviewLoading, setAudioPreviewLoading] = useState(false);

  // Video preview modal state
  const [videoPreviewModal, setVideoPreviewModal] = useState<{
    doc: StoryDocument;
    videoUrl: string;
  } | null>(null);
  const [videoPreviewLoading, setVideoPreviewLoading] = useState(false);

  const numberToOrdinal = (n: number): string => {
    const ordinals = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
    return n <= 10 ? ordinals[n - 1] : `${n}th`;
  };

  const formatStorageSize = (sizeInMB: number): string => {
    const gb = sizeInMB / 1024;
    
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    } else {
      return sizeInMB > 0 && sizeInMB < 0.05 ? '0.1 MB' : `${sizeInMB.toFixed(sizeInMB < 1 ? 1 : 2)} MB`;
    }
  };

  const formatFileSize = (sizeInBytes: number): string => {
    const sizeInMB = sizeInBytes / (1024 * 1024);
    const sizeInGB = sizeInMB / 1024;
    
    if (sizeInGB >= 1) {
      return `${sizeInGB.toFixed(1)} GB`;
    } else {
      return sizeInMB > 0 && sizeInMB < 0.05 ? '0.1 MB' : `${sizeInMB.toFixed(sizeInMB < 1 ? 1 : 2)} MB`;
    }
  };

  const getStorageLimit = (plan: string): string => {
    return getStorageLimitFormatted(plan);
  };

  const calculateFileSize = async (doc: StoryDocument) => {
    try {
      const { data: { session: _dSession } } = await supabase.auth.getSession();
      const response = await fetch('https://yilrqukialrbdzydvwmt.supabase.co/functions/v1/calculate-file-size', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_dSession?.access_token || ''}`,
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
        await supabase
          .from('story_documents')
          .update({ file_size })
          .eq('id', doc.id);
        setDocuments(prev => {
          const updated = { ...prev };
          Object.values(updated).forEach(group => {
            if (group.original?.id === doc.id) {
              group.original.file_size = file_size;
            }
            group.relatedDocuments = group.relatedDocuments.map(d =>
              d.id === doc.id ? { ...d, file_size } : d
            );
          });
          return updated;
        });
        setStorageUsed(prev => {
          if (prev === null) return null;
          const oldSize = (doc.word_count ?? 0) * 1.5;
          const delta = file_size - oldSize;
          const newTotalMB = (prev * 1024 * 1024 + delta) / (1024 * 1024);
          return Number(newTotalMB > 0 && newTotalMB < 0.05 ? '0.1' : newTotalMB.toFixed(newTotalMB < 1 ? 1 : 2));
        });
      }
    } catch (err: any) {
      console.error(`Error calculating file_size for ${doc.id}:`, err);
    }
  };

  useEffect(() => {
    const fetchDocumentsAndStorage = async () => {
      try {
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
          setError('Authentication error');
          setLoading(false);
          return;
        }

        // Fetch user plan
        const { data: planData, error: planError } = await supabase
          .from('user_plans')
          .select('plan_type')
          .eq('user_id', user.id)
          .eq('is_active', true)
          .single();
        
        if (planData) {
          setUserPlan(planData.plan_type || 'free');
        }

        const { data, error: fetchError } = await supabase
          .from('story_documents')
          .select('*, file_size, description')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
        if (fetchError) throw fetchError;
        const grouped = (data || []).reduce((acc: GroupedDocuments, doc: StoryDocument) => {
          const groupId = doc.group_id || doc.id;
          if (!acc[groupId]) {
            acc[groupId] = { original: null, relatedDocuments: [] };
          }
          if (doc.version === 1 && !acc[groupId].original) {
            acc[groupId].original = doc;
          } else {
            acc[groupId].relatedDocuments.push(doc);
          }
          return acc;
        }, {});
        const filteredGrouped = Object.fromEntries(
          Object.entries(grouped)
            .filter(([_, group]) => group.original || group.relatedDocuments.length > 0)
            .map(([groupId, group]) => {
              group.relatedDocuments.sort((a, b) => {
                return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
              });
              return [groupId, group];
            })
        );
        setDocuments(filteredGrouped);
        if (data) {
          data.forEach(doc => {
            if (doc.file_size == null || doc.file_size === 0) {
              calculateFileSize(doc);
            }
          });
        }
        let totalSize = 0;
        if (data && data.length > 0) {
          totalSize = data.reduce((sum, doc) => {
            if (doc.file_size != null && doc.file_size > 0) {
              return sum + doc.file_size;
            }
            const estimatedSize = (doc.word_count ?? 0) * 1.5;
            console.warn(`No valid file_size for document ${doc.id}, estimating ${estimatedSize} bytes from ${doc.word_count ?? 0} words`);
            return sum + estimatedSize;
          }, 0);
        } else {
          console.warn('No documents found for user:', user.id);
        }
        const totalSizeMB = totalSize / (1024 * 1024);
        const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? '0.1' : totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2);
        setStorageUsed(Number(formattedSize));
      } catch (err: any) {
        console.error('Error in fetchDocumentsAndStorage:', err);
        setError(err.message || 'Failed to fetch documents or storage data');
      } finally {
        setLoading(false);
      }
    };
    fetchDocumentsAndStorage();
  }, []);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleDownload = async (filePath: string, fileName: string, isAudio: boolean = false) => {
    try {
      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('stories')
        .createSignedUrl(filePath, 60);
      if (signedUrlError) {
        throw new Error(`Failed to generate signed URL: ${signedUrlError.message}`);
      }
      const response = await fetch(signedUrlData.signedUrl);
      if (!response.ok) {
        throw new Error('Failed to fetch file from signed URL');
      }
      const blob = await response.blob();
      const contentType = isAudio ? (filePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav') : 'text/plain';
      const url = window.URL.createObjectURL(new Blob([blob], { type: contentType }));
      const link = document.createElement('a');
      link.href = url;
      const extension = filePath.split('.').pop() || (isAudio ? 'mp3' : 'txt');
      link.setAttribute('download', fileName.endsWith(`.${extension}`) ? fileName : `${fileName}.${extension}`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || 'Failed to download document');
    }
  };

  const handleStreamingDownload = async (signedUrl: string, fileName: string, docId: string) => {
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
      
    } catch (err: any) {
      console.error(`Error in streaming download:`, err);
      setError(err.message || 'Failed to download large video file');
      setDownloadProgress(prev => ({ ...prev, [docId]: 0 }));
    }
  };

  const handleDownloadFolderAsZip = async (doc: StoryDocument, isAudioFolder: boolean = false, isVideoFolder: boolean = false) => {
    try {
      setDownloadingZips(prev => ({ ...prev, [doc.id]: true }));
      const folderPath = doc.file_path;
      const bucketName = 'stories'; // all folder types (images, audio, TTV) live in the 'stories' bucket
      let allFiles: any[] = [];
      const LIST_LIMIT = 100;
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: files, error: listError } = await supabase.storage
          .from(bucketName)
          .list(folderPath, { limit: LIST_LIMIT, offset });
        if (listError) {
          throw new Error(`Failed to list files in folder: ${listError.message}`);
        }
        allFiles = allFiles.concat(files);
        if (files.length < LIST_LIMIT) {
          hasMore = false;
        } else {
          offset += LIST_LIMIT;
        }
      }
      const targetFiles = allFiles.filter(file =>
        isVideoFolder ?
        file.name.endsWith('.mp4') :
        isAudioFolder ?
        (file.name.endsWith('.wav') || file.name.endsWith('.mp3')) :
        file.name.endsWith('.png')
      ).sort((a, b) => {
        // Numeric sort by filename prefix (1.mp4, 2.mp4 … 87.mp4)
        const aNum = parseInt(a.name.split('.')[0]) || 0;
        const bNum = parseInt(b.name.split('.')[0]) || 0;
        return aNum - bNum;
      });
      if (targetFiles.length === 0) {
        setError(`No ${isVideoFolder ? 'video clips' : isAudioFolder ? 'audio files' : 'images'} found in this folder`);
        return;
      }
      const zip = new JSZip();
      let filesAdded = 0;
      const MAX_RETRIES = 3;
      const N = targetFiles.length;
      const fileShare = 80 / N; // 0-80% range split equally per file (all folder types)

      for (let fi = 0; fi < N; fi++) {
        const file = targetFiles[fi];
        const clipBase = fi * fileShare;
        let success = false;
        let retries = 0;
        while (!success && retries < MAX_RETRIES) {
          try {
            const { data: signedUrlData, error: signedUrlError } = await supabase.storage
              .from(bucketName)
              .createSignedUrl(`${folderPath}/${file.name}`, 60);
            if (signedUrlError) {
              throw new Error(`Failed to generate signed URL for ${file.name}: ${signedUrlError.message}`);
            }
            if (isVideoFolder) {
              // Stream with per-byte progress for video clips
              const response = await fetch(signedUrlData.signedUrl);
              if (!response.ok) throw new Error(`Failed to fetch file ${file.name}: ${response.status}`);
              const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
              if (contentLength > 0 && response.body) {
                const reader = response.body.getReader();
                const chunks: ArrayBuffer[] = [];
                let received = 0;
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  chunks.push(value.buffer as ArrayBuffer);
                  received += value.length;
                  const pct = Math.min(
                    Math.round(clipBase + (received / contentLength) * fileShare),
                    79,
                  );
                  setZipFolderProgress(prev => ({ ...prev, [doc.id]: pct }));
                }
                const blob = new Blob(chunks, { type: 'video/mp4' });
                zip.file(file.name, blob);
              } else {
                const blob = await response.blob();
                zip.file(file.name, blob);
              }
            } else {
              // Images / audio — retry on transient failures
              let fetchRes: Response | null = null;
              for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                  fetchRes = await fetch(signedUrlData.signedUrl);
                  if (fetchRes.ok) break;
                  throw new Error(`HTTP ${fetchRes.status}`);
                } catch (fetchErr: any) {
                  if (attempt < MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
                  } else {
                    throw fetchErr;
                  }
                }
              }
              const blob = await fetchRes!.blob();
              zip.file(file.name, blob);
            }
            success = true;
            filesAdded++;
          } catch (err: any) {
            console.error(`Error processing ${file.name} (attempt ${retries + 1}):`, err);
            retries++;
            if (retries < MAX_RETRIES) {
              const delay = retries * 5000;
              console.log(`Retrying ${file.name} in ${delay / 1000} seconds...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }
        if (!success) {
          console.warn(`Failed to add ${file.name} after ${MAX_RETRIES} retries`);
        }
        // Advance progress after each file for all folder types
        setZipFolderProgress(prev => ({ ...prev, [doc.id]: Math.round((fi + 1) * fileShare) }));
      }
      if (filesAdded !== targetFiles.length) {
        setError(`Failed to include all files in the ZIP. Added ${filesAdded} out of ${targetFiles.length} files.`);
      }
      const zipBlob = await zip.generateAsync(
        { type: 'blob' },
        (metadata) => {
          const pct = 80 + Math.round(metadata.percent * 0.2);
          setZipFolderProgress(prev => ({ ...prev, [doc.id]: Math.min(pct, 100) }));
        },
      );
      const zipFileName = `${doc.title}.zip`;
      saveAs(zipBlob, zipFileName);
    } catch (err: any) {
      console.error('Error in handleDownloadFolderAsZip:', err);
      setError(err.message || 'Failed to download folder as ZIP');
    } finally {
      setDownloadingZips(prev => ({ ...prev, [doc.id]: false }));
      setZipFolderProgress(prev => ({ ...prev, [doc.id]: 0 }));
    }
  };

  const handleDownloadSingleImage = async (filePath: string, fileName: string, index: number) => {
    try {
      setDownloadingImages(prev => ({ ...prev, [index]: true }));
      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('stories')
        .createSignedUrl(filePath, 300, { download: fileName });
      if (signedUrlError || !signedUrlData) {
        throw new Error(`Failed to generate signed URL for ${fileName}: ${signedUrlError?.message}`);
      }
      const a = document.createElement('a');
      a.href = signedUrlData.signedUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err: any) {
      console.error(`Error downloading image ${fileName}:`, err);
      setError(err.message || `Failed to download image ${fileName}`);
    } finally {
      setDownloadingImages(prev => ({ ...prev, [index]: false }));
    }
  };

  const handleDownloadSingleAudio = async (doc: StoryDocument) => {
    try {
      setDownloadingAudios(prev => ({ ...prev, [doc.id]: true }));
      const extension = doc.file_path.split('.').pop() || 'mp3';
      const fullFileName = `${doc.title}.${extension}`;
      const isLargeFile = doc.file_size != null && doc.file_size >= LARGE_FILE_THRESHOLD;
      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('stories')
        .createSignedUrl(doc.file_path, isLargeFile ? 3600 : 300, { download: fullFileName });
      if (signedUrlError || !signedUrlData) {
        throw new Error(`Failed to generate signed URL for ${doc.title}: ${signedUrlError?.message}`);
      }
      if (isLargeFile) {
        setLargeVideoDownloadModal({
          fileName: fullFileName,
          fileSizeBytes: doc.file_size!,
          signedUrl: signedUrlData.signedUrl,
        });
      } else {
        const a = document.createElement('a');
        a.href = signedUrlData.signedUrl;
        a.download = fullFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err: any) {
      console.error(`Error downloading audio ${doc.title}:`, err);
      setError(err.message || `Failed to download audio ${doc.title}`);
    } finally {
      setDownloadingAudios(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleDownloadVideo = async (doc: StoryDocument) => {
    try {
      setDownloadingAudios(prev => ({ ...prev, [doc.id]: true }));

      const extension = doc.file_path.split('.').pop() || 'mp4';
      const rawName = doc.description === 'Final Video' ? doc.title : doc.description || doc.title;
      const fullFileName = `${sanitizeFileName(rawName)}.${extension}`;
      const isLargeFile = doc.file_size != null && doc.file_size >= LARGE_FILE_THRESHOLD;

      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('videos')
        .createSignedUrl(doc.file_path, isLargeFile ? 3600 : 300, { download: fullFileName });

      if (signedUrlError || !signedUrlData) {
        throw new Error(`Failed to generate signed URL for ${doc.title}: ${signedUrlError?.message}`);
      }

      if (isLargeFile) {
        // Large file — show info modal; download triggered via native anchor inside modal
        setLargeVideoDownloadModal({
          fileName: fullFileName,
          fileSizeBytes: doc.file_size!,
          signedUrl: signedUrlData.signedUrl,
        });
      } else {
        // Native anchor download — zero JS memory usage
        const a = document.createElement('a');
        a.href = signedUrlData.signedUrl;
        a.download = fullFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err: any) {
      console.error(`Error downloading video ${doc.title}:`, err);
      setError(err.message || `Failed to download video ${doc.title}`);
    } finally {
      setDownloadingAudios(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleDelete = async (docId: string, filePath: string, isFolder: boolean = false, isVideo: boolean = false) => {
    try {
      setDeletingDocs(prev => ({ ...prev, [docId]: true }));
      
      const bucketName = isVideo ? 'videos' : 'stories';
      
      console.log('Deleting file:', {
        docId,
        filePath,
        isFolder,
        isVideo,
        bucketName
      });
      
      if (isFolder) {
        const folderPath = filePath;
        // Paginate to handle folders with more than 100 files
        let allFiles: any[] = [];
        const LIST_LIMIT = 100;
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
          const { data: files, error: listError } = await supabase.storage
            .from(bucketName)
            .list(folderPath, { limit: LIST_LIMIT, offset });
          if (listError) throw new Error(`Failed to list files for deletion: ${listError.message}`);
          allFiles = allFiles.concat(files ?? []);
          hasMore = (files?.length ?? 0) >= LIST_LIMIT;
          offset += LIST_LIMIT;
        }
        const filePaths = allFiles
          .filter(file => file.name.endsWith('.png') || file.name.endsWith('.wav') || file.name.endsWith('.mp3') || file.name.endsWith('.mp4'))
          .map(file => `${folderPath}/${file.name}`);
        if (filePaths.length > 0) {
          // Delete in batches of 100 (Supabase storage remove limit)
          for (let i = 0; i < filePaths.length; i += 100) {
            const batch = filePaths.slice(i, i + 100);
            const { error: storageDeleteError } = await supabase.storage
              .from(bucketName)
              .remove(batch);
            if (storageDeleteError) {
              throw new Error(`Failed to delete folder files: ${storageDeleteError.message}`);
            }
          }
        }
      } else {
        console.log(`Attempting to delete file from ${bucketName} bucket: ${filePath}`);
        
        if (isVideo) {
          // For video files, we need to ensure proper authentication context
          const { data: { user }, error: authError } = await supabase.auth.getUser();
          if (authError || !user) {
            throw new Error('Authentication required for video deletion');
          }
          
          console.log('Authenticated user:', user.id);
          console.log('File path:', filePath);
          
          // Verify the user owns this file by checking the path structure
          const pathParts = filePath.split('/');
          if (pathParts.length >= 2 && pathParts[1] !== user.id) {
            throw new Error('You can only delete your own video files');
          }
          
          // Try deletion with explicit error handling
          const { error: storageDeleteError } = await supabase.storage
            .from('videos')
            .remove([filePath]);
            
          if (storageDeleteError) {
            console.error('Video deletion error:', storageDeleteError);
            
            // Check if it's a policy/permission error
            if (storageDeleteError.message.includes('policy') || 
                storageDeleteError.message.includes('permission') ||
                storageDeleteError.message.includes('RLS') ||
                storageDeleteError.statusCode === 403) {
              throw new Error(`Permission denied: Unable to delete video file. This may be due to storage policies. Please contact support.`);
            }
            
            throw new Error(`Failed to delete video file: ${storageDeleteError.message}`);
          }
          
          // Video successfully deleted - no verification needed
          console.log('Video file successfully deleted from storage');
          
        } else {
          // Original logic for non-video files
          const { error: storageDeleteError } = await supabase.storage
            .from(bucketName)
            .remove([filePath]);
          if (storageDeleteError) {
            console.error('Storage deletion error:', storageDeleteError);
            throw new Error(`Failed to delete file from storage: ${storageDeleteError.message}`);
          }
          console.log(`Successfully deleted file from storage: ${filePath}`);
        }
      }
  
      // Add delay for video files
      if (isVideo) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
  
      // Delete from database
      const { error: deleteError } = await supabase
        .from('story_documents')
        .delete()
        .eq('id', docId);
      if (deleteError) {
        throw new Error(`Failed to delete document: ${deleteError.message}`);
      }
      console.log(`Successfully deleted document from database: ${docId}`);
  
      // Refresh documents list (rest of your existing code...)
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated');
      
      const { data, error: fetchError } = await supabase
        .from('story_documents')
        .select('*, file_size, description')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (fetchError) throw fetchError;
      
      const grouped = (data || []).reduce((acc: GroupedDocuments, doc: StoryDocument) => {
        const groupId = doc.group_id || doc.id;
        if (!acc[groupId]) {
          acc[groupId] = { original: null, relatedDocuments: [] };
        }
        if (doc.version === 1 && !acc[groupId].original) {
          acc[groupId].original = doc;
        } else {
          acc[groupId].relatedDocuments.push(doc);
        }
        return acc;
      }, {});
      
      const filteredGrouped = Object.fromEntries(
        Object.entries(grouped)
          .filter(([_, group]) => group.original || group.relatedDocuments.length > 0)
          .map(([groupId, group]) => {
            group.relatedDocuments.sort((a, b) => {
              return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
            });
            return [groupId, group];
          })
      );
      setDocuments(filteredGrouped);
      
      // Recalculate storage (rest of your existing code...)
      if (data) {
        data.forEach(doc => {
          if (doc.file_size == null || doc.file_size === 0) {
            calculateFileSize(doc);
          }
        });
      }
      
      let totalSize = 0;
      if (data && data.length > 0) {
        totalSize = data.reduce((sum, doc) => {
          if (doc.file_size != null && doc.file_size > 0) {
            return sum + doc.file_size;
          }
          const estimatedSize = (doc.word_count ?? 0) * 1.5;
          return sum + estimatedSize;
        }, 0);
      }
      
      const totalSizeMB = totalSize / (1024 * 1024);
      const formattedSize = totalSizeMB > 0 && totalSizeMB < 0.05 ? '0.1' : totalSizeMB.toFixed(totalSizeMB < 1 ? 1 : 2);
      setStorageUsed(Number(formattedSize));
      
    } catch (err: any) {
      console.error('Error in handleDelete:', err);
      setError(err.message || 'Failed to delete document');
    } finally {
      setDeletingDocs(prev => ({ ...prev, [docId]: false }));
    }
  };

  const sanitizeTitle = (title: string): string => {
    return title
      .replace(/[^a-zA-Z0-9\s_-]/g, '')
      .replace(/\s+/g, '_')
      .toLowerCase()
      .slice(0, 50);
  };

  // Maps a document's version to the column in video_tasks that links a video creation to that document.
  // If the document is referenced by any video_tasks row via this column, it means a video creation is
  // (or was) using this file/folder. We use this to detect "in-use by a video creation" precisely,
  // rather than falling back to a coarser group_id+tab lookup.
  const getVideoTaskDocColumn = (version?: number): string | null => {
    switch (version) {
      case 1: case 2: return 'story_document_id';
      case 3: case 4: return 'image_prompt_document_id';
      case 5: case 6: return 'image_folder_document_id';
      case 7: case 8: case 9: case 10: return 'audio_document_id';
      case 11: return 'video_document_id';
      case 12: case 13: return 'ttv_prompt_document_id';
      case 14: case 15: return 'ttv_folder_document_id';
      case 16: case 17: return 'itv_image_prompt_document_id';
      case 18: case 19: return 'image_folder_document_id';
      case 20: case 21: return 'itv_video_prompt_document_id';
      case 22: case 23: return 'itv_video_folder_document_id';
      default: return null;
    }
  };

  // Fetch video_tasks rows that reference this document via its link column.
  // Returns [] when nothing references the doc, or null on error / no mapping.
  const fetchVideoTasksByDocLink = async (
    doc: StoryDocument,
    userId: string,
  ): Promise<any[] | null> => {
    const col = getVideoTaskDocColumn(doc.version);
    if (!col) return null;
    const { data, error } = await supabase
      .from('video_tasks')
      .select('id, overall_status, story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, doc_id, group_id, tab')
      .eq('user_id', userId)
      .eq(col, doc.id);
    if (error) {
      console.error(`Error checking video_tasks via ${col}:`, error);
      return null;
    }
    return data || [];
  };

  const handleStoryDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }

      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;

      // FIRST: check video_tasks via document linkage. If this story doc is referenced by any
      // video_tasks row, the file is part of a video creation pipeline regardless of whether
      // story_tasks rows still exist (they may have been cleared by a prior step).
      {
        const linked = await fetchVideoTasksByDocLink(doc, user.id);
        if (linked && linked.length > 0) {
          const allCompleted = linked.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allCompleted ? 'video-completed' : 'video-active',
            videoTasks: linked,
          });
          return;
        }
      }

      // Check story_tasks for this group
      const { data: storyTasks, error: storyTasksError } = await supabase
        .from('story_tasks')
        .select('id, video_process')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab);

      if (storyTasksError) {
        console.error('Error checking story_tasks:', storyTasksError);
        // Fall back to direct delete on error
        await handleDelete(doc.id, doc.file_path, false, false);
        return;
      }

      // No tasks — still confirm before deleting
      if (!storyTasks || storyTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }

      // Check if any task is part of a video pipeline
      const hasVideoProcess = storyTasks.some(t => t.video_process === true);

      if (!hasVideoProcess) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'story-generator-only' });
        return;
      }

      // Has video process — check video_tasks via document linkage (story_document_id)
      const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);

      if (!videoTasks || videoTasks.length === 0) {
        // No video tasks reference this story doc — treat as story-only
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'story-generator-only' });
        return;
      }

      const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');

      if (allVideoCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-completed', videoTasks });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-active', videoTasks });
      }
    } catch (err: any) {
      console.error('Error checking delete status:', err);
      // Fall back to direct delete on unexpected error
      await handleDelete(doc.id, doc.file_path, false, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleConfirmDelete = async (overrideState?: DeleteConfirmModalState) => {
    const activeState = overrideState ?? deleteConfirmModal;
    if (!activeState) return;
    const { doc, userId, groupId, tab, scenario, videoTasks, imageFolderMode } = activeState;
    setConfirmDeleting(true);

    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))]);

    try {
      if (scenario === 'simple-delete') {
        // No task cleanup needed — proceed directly to file + DB deletion below

      } else if (scenario === 'story-generator-only') {
        // Delete all story_tasks for this group+tab
        await supabase.from('story_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        // Reset story tab to defaults
        const { resetTabToDefaults } = await import('../utils/tabManager');
        await resetTabToDefaults(userId, 'story', tab);

      } else if (scenario === 'video-completed') {
        // Mirrors handleDone in VideoGenerator — DB cleanup only, completed files are preserved
        await supabase.from('video_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('story_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        await supabase.from('image_prompt_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        await supabase.from('image_prompt_context').delete().eq('group_id', groupId);
        await supabase.from('image_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        await supabase.from('audio_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        // Reset video tab to defaults
        const { resetTabToDefaults } = await import('../utils/tabManager');
        await resetTabToDefaults(userId, 'video', tab);

      } else if (scenario === 'video-active') {
        // Mirrors handleStopGeneration in VideoGenerator — selective file cleanup based on completion
        const mainTask = videoTasks?.find(t => t.is_main) || videoTasks?.find(t => t.doc_id === null) || videoTasks?.[0];
        const storyCompleted = mainTask?.story_status === 'completed' || mainTask?.story_status === 'completed_final';
        const imageGenerationCompleted = mainTask?.image_generation_status === 'completed' || mainTask?.image_generation_status === 'completed_final';
        const audioCompleted = mainTask?.audio_status === 'completed' || mainTask?.audio_status === 'completed_final';
        const videoCreationCompleted = mainTask?.video_creation_status === 'completed' || mainTask?.video_creation_status === 'completed_final';

        // Clean up incomplete story files
        if (!storyCompleted) {
          try {
            const storyPath = `documents/${userId}/${groupId}`;
            const { data: files } = await withTimeout(
              supabase.storage.from('stories').list(storyPath, { limit: 1000 }),
              30000
            );
            if (files && files.length > 0) {
              const storyFilePaths = files.filter(f => f.name.endsWith('.txt')).map(f => `${storyPath}/${f.name}`);
              if (storyFilePaths.length > 0) await supabase.storage.from('stories').remove(storyFilePaths);
            }
          } catch (e) { console.warn('Failed to clean up story files:', e); }
        }

        // Clean up incomplete image files
        if (!imageGenerationCompleted) {
          try {
            const { data: imageTasks } = await supabase
              .from('image_tasks').select('story_title, folder_timestamp')
              .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true).limit(1);
            if (imageTasks && imageTasks.length > 0 && imageTasks[0].story_title && imageTasks[0].folder_timestamp) {
              const folderPath = `documents/${userId}/${groupId}/${sanitizeTitle(imageTasks[0].story_title)}_${imageTasks[0].folder_timestamp}`;
              const { data: files } = await supabase.storage.from('stories').list(folderPath, { recursive: true });
              if (files && files.length > 0) {
                const paths = files.filter(f => f.name.endsWith('.png') || f.name.endsWith('.jpg') || f.name.endsWith('.jpeg') || f.name.endsWith('.webp')).map(f => `${folderPath}/${f.name}`);
                if (paths.length > 0) await supabase.storage.from('stories').remove(paths);
              }
            }
          } catch (e) { console.warn('Failed to clean up image files:', e); }
        }

        // Clean up incomplete audio files
        if (!audioCompleted) {
          try {
            const { data: audioTasks } = await supabase
              .from('audio_tasks').select('story_title, folder_timestamp')
              .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true).limit(1);
            if (audioTasks && audioTasks.length > 0 && audioTasks[0].story_title && audioTasks[0].folder_timestamp) {
              const folderPath = `documents/${userId}/${groupId}/${sanitizeTitle(audioTasks[0].story_title)}_${audioTasks[0].folder_timestamp}`;
              const { data: files } = await supabase.storage.from('stories').list(folderPath, { recursive: true });
              if (files && files.length > 0) {
                const paths = files.filter(f => f.name.endsWith('.wav') || f.name.endsWith('.mp3')).map(f => `${folderPath}/${f.name}`);
                if (paths.length > 0) await supabase.storage.from('stories').remove(paths);
              }
            }
          } catch (e) { console.warn('Failed to clean up audio files:', e); }
        }

        // Clean up incomplete video files
        if (!videoCreationCompleted) {
          try {
            const individualPath = `videos/${userId}/${groupId}/individual_videos`;
            const { data: indivFiles } = await supabase.storage.from('videos').list(individualPath, { recursive: true });
            if (indivFiles && indivFiles.length > 0) await supabase.storage.from('videos').remove(indivFiles.map(f => `${individualPath}/${f.name}`));
          } catch (e) { console.warn('Failed to clean up individual video files:', e); }
          try {
            const transitionPath = `videos/${userId}/${groupId}/transition_batches`;
            const { data: transFiles } = await supabase.storage.from('videos').list(transitionPath, { recursive: true });
            if (transFiles && transFiles.length > 0) await supabase.storage.from('videos').remove(transFiles.map(f => `${transitionPath}/${f.name}`));
          } catch (e) { console.warn('Failed to clean up transition batch files:', e); }
        }

        // Delete all DB records
        await supabase.from('video_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('story_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        await supabase.from('image_prompt_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        await supabase.from('image_prompt_context').delete().eq('group_id', groupId);
        await supabase.from('image_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        await supabase.from('audio_tasks').delete().eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('video_process', true);
        // Reset video tab to defaults
        const { resetTabToDefaults } = await import('../utils/tabManager');
        await resetTabToDefaults(userId, 'video', tab);

      } else if (scenario === 'image-prompts-only') {
        // Mirrors handleDone in ImagePrompts — delete tasks + context and reset image_prompt tab
        await supabase.from('image_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .eq('process_image', false);
        await supabase.from('image_prompt_context').delete().eq('group_id', groupId);
        const { resetImageTabToDefaults } = await import('../utils/tabManager');
        await resetImageTabToDefaults(userId, tab);

      } else if (scenario === 'image-generator-completed') {
        // Mirrors handleDone in ImageGenerator — DB cleanup only, completed image files are preserved
        await supabase.from('image_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .eq('process_image', true);
        await supabase.from('image_prompt_context').delete().eq('group_id', groupId);
        await supabase.from('image_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .or('video_process.is.null,video_process.eq.false');
        const { resetImageGeneratorTabToDefaults, resetImageTabToDefaults } = await import('../utils/tabManager');
        await resetImageGeneratorTabToDefaults(userId, tab);
        await resetImageTabToDefaults(userId, tab);

      } else if (scenario === 'image-generator-active') {
        // Mirrors handleDone in ImageGenerator when generating — delete in-progress image files + tasks
        try {
          const { data: imgTasks } = await supabase
            .from('image_tasks')
            .select('story_title, folder_timestamp')
            .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
            .or('video_process.is.null,video_process.eq.false').limit(1);
          if (imgTasks && imgTasks.length > 0 && imgTasks[0].story_title && imgTasks[0].folder_timestamp) {
            const folderPath = `documents/${userId}/${groupId}/${sanitizeTitle(imgTasks[0].story_title)}_${imgTasks[0].folder_timestamp}`;
            const { data: files } = await supabase.storage.from('stories').list(folderPath, { recursive: true });
            if (files && files.length > 0) {
              const filePaths = files.slice(0, 1000).map(f => `${folderPath}/${f.name}`);
              await supabase.storage.from('stories').remove(filePaths);
            }
          }
        } catch (e) { console.warn('Failed to clean up in-progress image generation files:', e); }
        await supabase.from('image_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .eq('process_image', true);
        await supabase.from('image_prompt_context').delete().eq('group_id', groupId);
        await supabase.from('image_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .or('video_process.is.null,video_process.eq.false');
        const { resetImageGeneratorTabToDefaults, resetImageTabToDefaults } = await import('../utils/tabManager');
        await resetImageGeneratorTabToDefaults(userId, tab);
        await resetImageTabToDefaults(userId, tab);

      } else if (scenario === 'image-folder-completed') {
        // Mirrors handleDone in ImageGenerator from completed state — DB cleanup only, image files preserved as the folder document
        if (imageFolderMode === 'new-prompts') {
          await supabase.from('image_prompt_tasks').delete()
            .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
            .eq('process_image', true);
          await supabase.from('image_prompt_context').delete().eq('group_id', groupId);
        }
        await supabase.from('image_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .or('video_process.is.null,video_process.eq.false');
        const { resetImageGeneratorTabToDefaults: resetImgGen, resetImageTabToDefaults: resetImgPrompt } = await import('../utils/tabManager');
        await resetImgGen(userId, tab);
        if (imageFolderMode === 'new-prompts') {
          await resetImgPrompt(userId, tab);
        }

      } else if (scenario === 'image-folder-active') {
        // Mirrors handleDone in ImageGenerator while generating — stop image generation, DB cleanup
        // The folder files are deleted by handleDelete below (isFolder=true)
        if (imageFolderMode === 'new-prompts') {
          await supabase.from('image_prompt_tasks').delete()
            .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
            .eq('process_image', true);
          await supabase.from('image_prompt_context').delete().eq('group_id', groupId);
        }
        await supabase.from('image_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .or('video_process.is.null,video_process.eq.false');
        const { resetImageGeneratorTabToDefaults: resetImgGen2, resetImageTabToDefaults: resetImgPrompt2 } = await import('../utils/tabManager');
        await resetImgGen2(userId, tab);
        if (imageFolderMode === 'new-prompts') {
          await resetImgPrompt2(userId, tab);
        }

      } else if (scenario === 'audio-tts-completed') {
        // Mirrors handleDone in TextToSpeech from completed state — delete tasks, reset tab
        await supabase.from('audio_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .eq('single_audio', false).or('video_process.is.null,video_process.eq.false');
        const { resetAudioTabToDefaults } = await import('../utils/tabManager');
        await resetAudioTabToDefaults(userId, tab);

      } else if (scenario === 'audio-tts-active') {
        // Mirrors handleDone in TextToSpeech while generating — delete in-progress audio files then tasks
        // Query tasks to find folder path for partial file cleanup
        const { data: audioTasks } = await supabase.from('audio_tasks')
          .select('story_title, folder_timestamp')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .or('video_process.is.null,video_process.eq.false');

        if (audioTasks && audioTasks.length > 0) {
          const taskWithTimestamp = audioTasks.find(t => t.story_title && t.folder_timestamp);
          if (taskWithTimestamp) {
            const sanitizedT = sanitizeTitle(taskWithTimestamp.story_title);
            const folderPath = `documents/${userId}/${groupId}/${sanitizedT}_${taskWithTimestamp.folder_timestamp}`;
            try {
              const { data: files } = await supabase.storage.from('stories').list(folderPath);
              if (files && files.length > 0) {
                const filePaths = files
                  .filter(f => f.name.endsWith('.wav') || f.name.endsWith('.mp3'))
                  .map(f => `${folderPath}/${f.name}`);
                if (filePaths.length > 0) {
                  await supabase.storage.from('stories').remove(filePaths);
                }
              }
            } catch (storageErr: any) {
              console.warn('Audio folder cleanup error:', storageErr.message);
            }
          }
        }
        await supabase.from('audio_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .eq('single_audio', false).or('video_process.is.null,video_process.eq.false');
        const { resetAudioTabToDefaults: resetAudio2 } = await import('../utils/tabManager');
        await resetAudio2(userId, tab);

      } else if (scenario === 'video-file-completed') {
        // Mirrors handleDone in VideoGenerator — delete video_tasks DB records only (files are preserved)
        await supabase.from('video_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        // Reset video tab to defaults (clears estimate_tokens and form inputs)
        const { resetVideoTabToDefaults } = await import('../utils/tabManager');
        await resetVideoTabToDefaults(userId, tab);

      } else if (scenario === 'ttv-prompts-completed') {
        // Mirrors handleDone in TextToVideoGenerator from completed state — DB cleanup only, completed video clips preserved
        await supabase.from('TTV_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);
        const { resetTTVTabToDefaults } = await import('../utils/tabManager');
        await resetTTVTabToDefaults(userId, tab);

      } else if (scenario === 'ttv-prompts-active') {
        // Mirrors handleStop in TextToVideoGenerator — stop TTV, clean up in-progress video files, delete DB records
        await supabase.from('TTV_prompt_tasks').update({ stop_requested: true })
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_tasks').update({ stop_requested: true })
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        try {
          const { data: ttvTasks } = await supabase.from('TTV_tasks')
            .select('story_title, folder_timestamp')
            .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
          if (ttvTasks && ttvTasks.length > 0) {
            const taskWithTimestamp = ttvTasks.find((t: any) => t.story_title && t.folder_timestamp);
            if (taskWithTimestamp) {
              const cleanTitle = (taskWithTimestamp.story_title || '')
                .replace(/^TTV Prompt:\s*/i, '')
                .replace(/^TTV Prompts:\s*/i, '');
              // Use server-side sanitize pattern to match the actual storage path
              const sanitizedForPath = cleanTitle.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
              const folderPath = `documents/${userId}/${groupId}/TTV-${sanitizedForPath}_${taskWithTimestamp.folder_timestamp}`;
              const { data: files } = await supabase.storage.from('stories').list(folderPath);
              if (files && files.length > 0) {
                await supabase.storage.from('stories').remove(files.map((f: any) => `${folderPath}/${f.name}`));
              }
            }
          }
        } catch (e) { console.warn('Failed to clean up in-progress TTV video files:', e); }
        await supabase.from('TTV_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);
        const { resetTTVTabToDefaults: resetTTV2 } = await import('../utils/tabManager');
        await resetTTV2(userId, tab);

      } else if (scenario === 'ttv-folder-completed') {
        // Mirrors handleDone in TextToVideoGenerator — DB cleanup; folder files deleted by handleDelete below
        await supabase.from('TTV_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);
        const { resetTTVTabToDefaults: resetTTV3 } = await import('../utils/tabManager');
        await resetTTV3(userId, tab);

      } else if (scenario === 'ttv-folder-active') {
        // Mirrors handleStop in TextToVideoGenerator — signal stop, delete DB records; folder files deleted by handleDelete below
        await supabase.from('TTV_prompt_tasks').update({ stop_requested: true })
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_tasks').update({ stop_requested: true })
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('TTV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);
        const { resetTTVTabToDefaults: resetTTV4 } = await import('../utils/tabManager');
        await resetTTV4(userId, tab);

      } else if (scenario === 'itv-image-prompts-completed') {
        // ITV Phase 1 image prompts completed — delete ITV_prompt_tasks (itv=false)
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', false);

      } else if (scenario === 'itv-image-prompts-active') {
        // ITV Phase 1 image prompts active — signal stop then delete
        await supabase.from('ITV_prompt_tasks').update({ stop_requested: true })
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', false);
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', false);

      } else if (scenario === 'itv-image-folder-completed') {
        // ITV keyframe image folder completed — delete image_tasks (itv=true) and Phase 1 prompt tasks
        await supabase.from('image_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', true);
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', false);

      } else if (scenario === 'itv-image-folder-active') {
        // ITV keyframe image folder active — delete DB rows; folder files deleted by handleDelete below
        await supabase.from('image_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', true);
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', false);

      } else if (scenario === 'itv-video-prompts-completed') {
        // ITV Phase 2 video prompts completed — delete all ITV_prompt_tasks and context
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);

      } else if (scenario === 'itv-video-prompts-active') {
        // ITV Phase 2 video prompts active — signal stop then delete
        await supabase.from('ITV_prompt_tasks').update({ stop_requested: true })
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);

      } else if (scenario === 'itv-folder-completed') {
        // ITV video folder completed — delete ITV_tasks and all prompt rows; folder files deleted by handleDelete below
        await supabase.from('ITV_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);

      } else if (scenario === 'itv-folder-active') {
        // ITV video folder active — signal stop, delete all ITV DB rows; folder files deleted by handleDelete below
        await supabase.from('ITV_tasks').update({ stop_requested: true })
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_prompt_tasks').delete()
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        await supabase.from('ITV_prompt_context').delete()
          .eq('group_id', groupId).eq('tab', tab);
      }

      // Close modal before performing the final file + DB row deletion
      setDeleteConfirmModal(null);
      // isFolder covers image folders (v5/v6), audio folders (v9/v10), TTV video folders (v14/v15),
      // ITV image folders (v18/v19), ITV video folders (v22/v23), and MG video folders (v26/v27)
      // isVideo covers ONLY the compiled final video (v11) — all folder types are in the 'stories' bucket
      const isFolder = doc.version === 5 || doc.version === 6 || doc.version === 9 || doc.version === 10 || doc.version === 14 || doc.version === 15 || doc.version === 18 || doc.version === 19 || doc.version === 22 || doc.version === 23 || doc.version === 26 || doc.version === 27;
      const isVideo = doc.version === 11;
      await handleDelete(doc.id, doc.file_path, isFolder, isVideo);

    } catch (err: any) {
      console.error('Error in handleConfirmDelete:', err);
      setError(err.message || 'Failed to delete document');
    } finally {
      setConfirmDeleting(false);
    }
  };

  const handleImagePromptDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }

      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;

      // FIRST: check video_tasks via document linkage (image_prompt_document_id).
      {
        const linked = await fetchVideoTasksByDocLink(doc, user.id);
        if (linked && linked.length > 0) {
          const allCompleted = linked.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allCompleted ? 'video-completed' : 'video-active',
            videoTasks: linked,
          });
          return;
        }
      }

      // Check image_prompt_tasks for this group
      const { data: promptTasks, error: promptTasksError } = await supabase
        .from('image_prompt_tasks')
        .select('id, video_process, process_image')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab);

      if (promptTasksError) {
        console.error('Error checking image_prompt_tasks:', promptTasksError);
        await handleDelete(doc.id, doc.file_path, false, false);
        return;
      }

      // No tasks — still confirm before deleting
      if (!promptTasks || promptTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }

      // Check if any task is part of a video pipeline
      const hasVideoProcess = promptTasks.some(t => t.video_process === true);

      if (hasVideoProcess) {
        // Check video_tasks via document linkage (image_prompt_document_id)
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (!videoTasks || videoTasks.length === 0) {
          setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'image-prompts-only' });
          return;
        }

        const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
        if (allVideoCompleted) {
          setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-completed', videoTasks });
        } else {
          setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-active', videoTasks });
        }
        return;
      }

      // No video process — check process_image flag
      const hasProcessImage = promptTasks.some(t => t.process_image === true);

      if (!hasProcessImage) {
        // Standalone image prompts only — will clear Image Prompts completion screen
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'image-prompts-only' });
        return;
      }

      // process_image = true — check image_tasks completion status
      const { data: imageTasks, error: imageTasksError } = await supabase
        .from('image_tasks')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .or('video_process.is.null,video_process.eq.false');

      if (imageTasksError || !imageTasks || imageTasks.length === 0) {
        // No image tasks found — treat as prompts-only
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'image-prompts-only' });
        return;
      }

      const allImageCompleted = imageTasks.every(t => t.status === 'completed_final');
      if (allImageCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'image-generator-completed', imageTasksCompleted: true });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'image-generator-active', imageTasksCompleted: false });
      }
    } catch (err: any) {
      console.error('Error checking image prompt delete status:', err);
      await handleDelete(doc.id, doc.file_path, false, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleImageFolderDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }

      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;

      // FIRST: check video_tasks via document linkage (image_folder_document_id). If this folder
      // is referenced by any video_tasks row, it is in use by a video creation — even if no
      // image_tasks rows currently exist (they may have been cleared at a later pipeline stage).
      {
        const linked = await fetchVideoTasksByDocLink(doc, user.id);
        if (linked && linked.length > 0) {
          const allCompleted = linked.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allCompleted ? 'video-completed' : 'video-active',
            videoTasks: linked,
          });
          return;
        }
      }

      // Query image_tasks for this group (exclude single_image=true which are unrelated single-image generations)
      const { data: imageTasks, error: imageTasksError } = await supabase
        .from('image_tasks')
        .select('id, status, video_process')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('single_image', false);

      if (imageTasksError) {
        console.error('Error checking image_tasks:', imageTasksError);
        await handleDelete(doc.id, doc.file_path, true, false);
        return;
      }

      // No tasks — still confirm before deleting
      if (!imageTasks || imageTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }

      // Check if any task is part of a video pipeline
      const hasVideoProcess = imageTasks.some(t => t.video_process === true);

      if (hasVideoProcess) {
        // Check video_tasks via document linkage (image_folder_document_id)
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          if (allVideoCompleted) {
            setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-completed', videoTasks });
          } else {
            setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-active', videoTasks });
          }
          return;
        }
        // No video_tasks reference this folder — fall through to non-video handling
      }

      // Non-video image tasks — determine mode: New Image Prompts vs Use Image Prompts
      // New Image Prompts = image_prompt_tasks with process_image=true exist (combined workflow)
      // Use Image Prompts = standalone image generation, no combined prompt tasks
      const nonVideoTasks = imageTasks.filter(t => !t.video_process);

      const { data: promptTasks } = await supabase
        .from('image_prompt_tasks')
        .select('id')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('process_image', true)
        .limit(1);

      const imageFolderMode: 'new-prompts' | 'use-prompts' =
        (promptTasks && promptTasks.length > 0) ? 'new-prompts' : 'use-prompts';

      const allCompleted = nonVideoTasks.every(t => t.status === 'completed_final');
      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'image-folder-completed', imageFolderMode });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'image-folder-active', imageFolderMode });
      }
    } catch (err: any) {
      console.error('Error checking image folder delete status:', err);
      await handleDelete(doc.id, doc.file_path, true, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleTTVPromptDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }

      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;

      // First, check video_tasks via document linkage (ttv_prompt_document_id)
      {
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allVideoCompleted ? 'video-completed' : 'video-active',
            videoTasks,
          });
          return;
        }
      }

      // Check TTV_prompt_tasks for this group
      const { data: promptTasks, error: promptTasksError } = await supabase
        .from('TTV_prompt_tasks')
        .select('id')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab);

      if (promptTasksError) {
        console.error('Error checking TTV_prompt_tasks:', promptTasksError);
        await handleDelete(doc.id, doc.file_path, false, false);
        return;
      }

      // No tasks — proceed with direct delete, no popup needed
      if (!promptTasks || promptTasks.length === 0) {
        await handleDelete(doc.id, doc.file_path, false, false);
        return;
      }

      // TTV always treats generation as linked — check TTV_tasks completion status
      const { data: ttvTasks, error: ttvTasksError } = await supabase
        .from('TTV_tasks')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab);

      if (ttvTasksError || !ttvTasks || ttvTasks.length === 0) {
        // No TTV tasks — treat as completed (only prompt tasks remain)
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'ttv-prompts-completed' });
        return;
      }

      const allCompleted = ttvTasks.every((t: any) => t.status === 'completed_final');
      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'ttv-prompts-completed' });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'ttv-prompts-active' });
      }
    } catch (err: any) {
      console.error('Error checking TTV prompt delete status:', err);
      await handleDelete(doc.id, doc.file_path, false, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleTTVFolderDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }

      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;

      // First, check video_tasks via document linkage (ttv_folder_document_id)
      {
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allVideoCompleted ? 'video-completed' : 'video-active',
            videoTasks,
          });
          return;
        }
      }

      // Query TTV_tasks for this group
      const { data: ttvTasks, error: ttvTasksError } = await supabase
        .from('TTV_tasks')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab);

      if (ttvTasksError) {
        console.error('Error checking TTV_tasks:', ttvTasksError);
        await handleDelete(doc.id, doc.file_path, true, true);
        return;
      }

      // No tasks — still confirm before deleting
      if (!ttvTasks || ttvTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }

      const allCompleted = ttvTasks.every((t: any) => t.status === 'completed_final');
      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'ttv-folder-completed' });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'ttv-folder-active' });
      }
    } catch (err: any) {
      console.error('Error checking TTV folder delete status:', err);
      await handleDelete(doc.id, doc.file_path, true, true);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleAudioDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }

      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;
      const isFolder = doc.version === 9 || doc.version === 10;

      // FIRST: check video_tasks via document linkage (audio_document_id).
      {
        const linked = await fetchVideoTasksByDocLink(doc, user.id);
        if (linked && linked.length > 0) {
          const allCompleted = linked.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allCompleted ? 'video-completed' : 'video-active',
            videoTasks: linked,
          });
          return;
        }
      }

      // Query audio_tasks for this group and variant (exclude single_audio=true)
      let audioTasksQuery = supabase
        .from('audio_tasks')
        .select('id, status, video_process')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('single_audio', false);

      if (doc.variant !== undefined) {
        audioTasksQuery = audioTasksQuery.eq('variant', doc.variant);
      }

      const { data: audioTasks, error: audioTasksError } = await audioTasksQuery;

      if (audioTasksError) {
        console.error('Error checking audio_tasks:', audioTasksError);
        await handleDelete(doc.id, doc.file_path, isFolder, false);
        return;
      }

      // No tasks — still confirm before deleting
      if (!audioTasks || audioTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }

      // Check if any task is part of a video pipeline
      const hasVideoProcess = audioTasks.some(t => t.video_process === true);

      if (hasVideoProcess) {
        // Check video_tasks via document linkage (audio_document_id)
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          if (allVideoCompleted) {
            setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-completed', videoTasks });
          } else {
            setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-active', videoTasks });
          }
          return;
        }
        // No video_tasks reference this audio doc — fall through to standalone audio handling
      }

      // Standalone audio tasks (non-video)
      const nonVideoTasks = audioTasks.filter(t => !t.video_process);
      const allCompleted = nonVideoTasks.every(t => t.status === 'completed_final');

      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'audio-tts-completed' });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'audio-tts-active' });
      }
    } catch (err: any) {
      console.error('Error checking audio delete status:', err);
      const isFolder = doc.version === 9 || doc.version === 10;
      await handleDelete(doc.id, doc.file_path, isFolder, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleVideoDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }

      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;

      // Check video_tasks via document linkage (video_document_id) — if any row references this
      // final video file, the video creation either produced it (completed) or is still using it.
      const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);

      if (videoTasks === null) {
        // Fall back to direct delete on error
        await handleDelete(doc.id, doc.file_path, false, true);
        return;
      }

      // No tasks via doc-link — fallback: query video_tasks directly by group_id + tab,
      // since video_document_id may not be populated for all completed tasks.
      let resolvedTasks = videoTasks;
      if (videoTasks.length === 0) {
        const { data: fallbackTasks, error: fallbackError } = await supabase
          .from('video_tasks')
          .select('id, overall_status')
          .eq('user_id', user.id)
          .eq('group_id', groupId)
          .eq('tab', tab);
        if (!fallbackError && fallbackTasks && fallbackTasks.length > 0) {
          resolvedTasks = fallbackTasks;
        }
      }

      if (resolvedTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }

      const hasCompletedFinal = resolvedTasks.some((t: any) => t.overall_status === 'completed_final');

      if (hasCompletedFinal) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'video-file-completed' });
      } else {
        // Tasks exist but not completed_final — still confirm
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
      }
    } catch (err: any) {
      console.error('Error checking video delete status:', err);
      await handleDelete(doc.id, doc.file_path, false, true);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleITVImagePromptDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) { setError('Authentication error'); return; }
      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;
      // First, check video_tasks via document linkage (itv_image_prompt_document_id)
      {
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allVideoCompleted ? 'video-completed' : 'video-active',
            videoTasks,
          });
          return;
        }
      }
      const { data: promptTasks, error: promptTasksError } = await supabase
        .from('ITV_prompt_tasks')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('itv', false);
      if (promptTasksError || !promptTasks || promptTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }
      const allCompleted = promptTasks.every((t: any) => t.status === 'completed_final');
      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-image-prompts-completed' });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-image-prompts-active' });
      }
    } catch (err: any) {
      console.error('Error checking ITV image prompt delete status:', err);
      await handleDelete(doc.id, doc.file_path, false, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleITVImageFolderDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) { setError('Authentication error'); return; }
      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;
      // First, check video_tasks via document linkage (image_folder_document_id for ITV image folders)
      {
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allVideoCompleted ? 'video-completed' : 'video-active',
            videoTasks,
          });
          return;
        }
      }
      const { data: imageTasks, error: imageTasksError } = await supabase
        .from('image_tasks')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('itv', true);
      if (imageTasksError || !imageTasks || imageTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }
      const allCompleted = imageTasks.every((t: any) => t.status === 'completed_final' || t.status === 'completed');
      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-image-folder-completed' });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-image-folder-active' });
      }
    } catch (err: any) {
      console.error('Error checking ITV image folder delete status:', err);
      await handleDelete(doc.id, doc.file_path, true, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleITVVideoPromptDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) { setError('Authentication error'); return; }
      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;
      // First, check video_tasks via document linkage (itv_video_prompt_document_id)
      {
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allVideoCompleted ? 'video-completed' : 'video-active',
            videoTasks,
          });
          return;
        }
      }
      const { data: promptTasks, error: promptTasksError } = await supabase
        .from('ITV_prompt_tasks')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab)
        .eq('itv', true);
      if (promptTasksError || !promptTasks || promptTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }
      const allCompleted = promptTasks.every((t: any) => t.status === 'completed_final');
      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-video-prompts-completed' });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-video-prompts-active' });
      }
    } catch (err: any) {
      console.error('Error checking ITV video prompt delete status:', err);
      await handleDelete(doc.id, doc.file_path, false, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleITVFolderDeleteClick = async (doc: StoryDocument) => {
    try {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: true }));
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) { setError('Authentication error'); return; }
      const groupId = doc.group_id || doc.id;
      const tab = doc.tab ?? 1;
      // First, check video_tasks via document linkage (itv_video_folder_document_id)
      {
        const videoTasks = await fetchVideoTasksByDocLink(doc, user.id);
        if (videoTasks && videoTasks.length > 0) {
          const allVideoCompleted = videoTasks.every(t => t.overall_status === 'completed_final');
          setDeleteConfirmModal({
            doc, userId: user.id, groupId, tab,
            scenario: allVideoCompleted ? 'video-completed' : 'video-active',
            videoTasks,
          });
          return;
        }
      }
      const { data: itvTasks, error: itvTasksError } = await supabase
        .from('ITV_tasks')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('group_id', groupId)
        .eq('tab', tab);
      if (itvTasksError || !itvTasks || itvTasks.length === 0) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'simple-delete' });
        return;
      }
      const allCompleted = itvTasks.every((t: any) => t.status === 'completed_final');
      if (allCompleted) {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-folder-completed' });
      } else {
        setDeleteConfirmModal({ doc, userId: user.id, groupId, tab, scenario: 'itv-folder-active' });
      }
    } catch (err: any) {
      console.error('Error checking ITV folder delete status:', err);
      await handleDelete(doc.id, doc.file_path, true, false);
    } finally {
      setCheckingDelete(prev => ({ ...prev, [doc.id]: false }));
    }
  };

  const handleSimpleDeleteClick = async (doc: StoryDocument) => {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      setError('Authentication error');
      return;
    }
    setDeleteConfirmModal({
      doc,
      userId: user.id,
      groupId: doc.group_id || doc.id,
      tab: doc.tab ?? 1,
      scenario: 'simple-delete',
    });
  };

  // ----- Bulk selection / Mark-all -----
  // Active scenarios (those that stop in-progress generation) — used to determine the worst severity
  const ACTIVE_SCENARIOS: DeleteScenario[] = [
    'video-active',
    'image-generator-active',
    'image-folder-active',
    'audio-tts-active',
    'ttv-prompts-active',
    'ttv-folder-active',
    'itv-image-prompts-active',
    'itv-image-folder-active',
    'itv-video-prompts-active',
    'itv-folder-active',
  ];
  const isActiveScenario = (s: DeleteScenario) => ACTIVE_SCENARIOS.includes(s);

  // Severity rank: lower = more serious (active stops generation > completed cleanup > simple-delete)
  const scenarioSeverity = (s: DeleteScenario): number => {
    const activeIdx = ACTIVE_SCENARIOS.indexOf(s);
    if (activeIdx >= 0) return activeIdx; // 0..9
    if (s === 'simple-delete') return 100;
    return 50; // any non-active "completed"/cleanup scenario
  };

  // Build the rendered (top-to-bottom) order of visible docs honoring filterType
  const getOrderedVisibleDocs = (): StoryDocument[] => {
    const filtered = Object.entries(documents)
      .filter(([_, { original, relatedDocuments }]) => groupMatchesFilter(original, relatedDocuments));
    const list: StoryDocument[] = [];
    for (const [, { original, relatedDocuments }] of filtered) {
      if (original && (filterType === 'all' || (original.version === 11 && original.description === 'Final Video'))) {
        list.push(original);
      }
      const relateds = filterType === 'final-video'
        ? relatedDocuments.filter(d => d.version === 11 && d.description === 'Final Video')
        : relatedDocuments;
      for (const d of relateds) list.push(d);
    }
    return list;
  };

  const toggleMarkDoc = (docId: string) => {
    setMarkedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const handleMarkAllToggle = () => {
    const visible = getOrderedVisibleDocs();
    const visibleIds = visible.map(d => d.id);
    const allMarked = visibleIds.length > 0 && visibleIds.every(id => markedDocIds.has(id));
    if (allMarked) {
      // Unmark only the currently-visible ones (preserve any others)
      setMarkedDocIds(prev => {
        const next = new Set(prev);
        visibleIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setMarkedDocIds(prev => {
        const next = new Set(prev);
        visibleIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  // Mirrors per-version handleXxxDeleteClick logic, but returns the resolved state instead of opening a modal
  const resolveDocScenario = async (doc: StoryDocument, userId: string): Promise<DeleteConfirmModalState> => {
    const groupId = doc.group_id || doc.id;
    const tab = doc.tab ?? 1;
    const base = { doc, userId, groupId, tab };
    try {
      const v = doc.version ?? 0;

      // Universal video_tasks doc-link check: if any video_tasks row references this doc via its
      // version-specific link column, the file/folder is part of a video creation pipeline.
      // For v11 (final video) this maps to 'video-file-completed' / 'simple-delete'; for everything
      // else it maps to 'video-completed' / 'video-active'.
      {
        const linked = await fetchVideoTasksByDocLink(doc, userId);
        if (linked && linked.length > 0) {
          if (v === 11) {
            const hasCompletedFinal = linked.some((t: any) => t.overall_status === 'completed_final');
            return { ...base, scenario: hasCompletedFinal ? 'video-file-completed' : 'simple-delete' };
          }
          const allCompleted = linked.every((t: any) => t.overall_status === 'completed_final');
          return { ...base, scenario: allCompleted ? 'video-completed' : 'video-active', videoTasks: linked };
        }
      }

      // Story files (v1, v2)
      if (v === 1 || v === 2) {
        const { data: storyTasks } = await supabase.from('story_tasks')
          .select('id, video_process')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!storyTasks || storyTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const hasVideoProcess = storyTasks.some((t: any) => t.video_process === true);
        if (!hasVideoProcess) return { ...base, scenario: 'story-generator-only' };
        const { data: videoTasks } = await supabase.from('video_tasks')
          .select('id, overall_status, story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, doc_id')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!videoTasks || videoTasks.length === 0) return { ...base, scenario: 'story-generator-only' };
        const allCompleted = videoTasks.every((t: any) => t.overall_status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'video-completed' : 'video-active', videoTasks };
      }

      // Image prompts (v3, v4)
      if (v === 3 || v === 4) {
        const { data: promptTasks } = await supabase.from('image_prompt_tasks')
          .select('id, video_process, process_image')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!promptTasks || promptTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const hasVideoProcess = promptTasks.some((t: any) => t.video_process === true);
        if (hasVideoProcess) {
          const { data: videoTasks } = await supabase.from('video_tasks')
            .select('id, overall_status, story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, doc_id')
            .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
          if (!videoTasks || videoTasks.length === 0) return { ...base, scenario: 'image-prompts-only' };
          const allCompleted = videoTasks.every((t: any) => t.overall_status === 'completed_final');
          return { ...base, scenario: allCompleted ? 'video-completed' : 'video-active', videoTasks };
        }
        const hasProcessImage = promptTasks.some((t: any) => t.process_image === true);
        if (!hasProcessImage) return { ...base, scenario: 'image-prompts-only' };
        const { data: imageTasks } = await supabase.from('image_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab)
          .or('video_process.is.null,video_process.eq.false');
        if (!imageTasks || imageTasks.length === 0) return { ...base, scenario: 'image-prompts-only' };
        const allCompleted = imageTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'image-generator-completed' : 'image-generator-active', imageTasksCompleted: allCompleted };
      }

      // Image folder (v5, v6)
      if (v === 5 || v === 6) {
        const { data: imageTasks } = await supabase.from('image_tasks')
          .select('id, status, video_process')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('single_image', false);
        if (!imageTasks || imageTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const hasVideoProcess = imageTasks.some((t: any) => t.video_process === true);
        if (hasVideoProcess) {
          const { data: videoTasks } = await supabase.from('video_tasks')
            .select('id, overall_status, story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, doc_id')
            .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
          if (videoTasks && videoTasks.length > 0) {
            const allCompleted = videoTasks.every((t: any) => t.overall_status === 'completed_final');
            return { ...base, scenario: allCompleted ? 'video-completed' : 'video-active', videoTasks };
          }
        }
        const nonVideoTasks = imageTasks.filter((t: any) => !t.video_process);
        const { data: promptTasks } = await supabase.from('image_prompt_tasks')
          .select('id')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('process_image', true).limit(1);
        const imageFolderMode: 'new-prompts' | 'use-prompts' =
          (promptTasks && promptTasks.length > 0) ? 'new-prompts' : 'use-prompts';
        const allCompleted = nonVideoTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'image-folder-completed' : 'image-folder-active', imageFolderMode };
      }

      // Audio (v7-v10)
      if (v === 7 || v === 8 || v === 9 || v === 10) {
        let q = supabase.from('audio_tasks')
          .select('id, status, video_process')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('single_audio', false);
        if (doc.variant !== undefined) q = q.eq('variant', doc.variant);
        const { data: audioTasks } = await q;
        if (!audioTasks || audioTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const hasVideoProcess = audioTasks.some((t: any) => t.video_process === true);
        if (hasVideoProcess) {
          const { data: videoTasks } = await supabase.from('video_tasks')
            .select('id, overall_status, story_status, image_prompt_status, image_generation_status, audio_status, video_creation_status, doc_id')
            .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
          if (videoTasks && videoTasks.length > 0) {
            const allCompleted = videoTasks.every((t: any) => t.overall_status === 'completed_final');
            return { ...base, scenario: allCompleted ? 'video-completed' : 'video-active', videoTasks };
          }
        }
        const nonVideoTasks = audioTasks.filter((t: any) => !t.video_process);
        const allCompleted = nonVideoTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'audio-tts-completed' : 'audio-tts-active' };
      }

      // Final video (v11)
      if (v === 11) {
        const { data: videoTasks } = await supabase.from('video_tasks')
          .select('id, overall_status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!videoTasks || videoTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const hasCompletedFinal = videoTasks.some((t: any) => t.overall_status === 'completed_final');
        return { ...base, scenario: hasCompletedFinal ? 'video-file-completed' : 'simple-delete' };
      }

      // TTV prompts (v12, v13)
      if (v === 12 || v === 13) {
        const { data: promptTasks } = await supabase.from('TTV_prompt_tasks')
          .select('id')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!promptTasks || promptTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const { data: ttvTasks } = await supabase.from('TTV_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!ttvTasks || ttvTasks.length === 0) return { ...base, scenario: 'ttv-prompts-completed' };
        const allCompleted = ttvTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'ttv-prompts-completed' : 'ttv-prompts-active' };
      }

      // TTV folder (v14, v15)
      if (v === 14 || v === 15) {
        const { data: ttvTasks } = await supabase.from('TTV_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!ttvTasks || ttvTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const allCompleted = ttvTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'ttv-folder-completed' : 'ttv-folder-active' };
      }

      // ITV image prompts (v16, v17)
      if (v === 16 || v === 17) {
        const { data: promptTasks } = await supabase.from('ITV_prompt_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', false);
        if (!promptTasks || promptTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const allCompleted = promptTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'itv-image-prompts-completed' : 'itv-image-prompts-active' };
      }

      // ITV image folder (v18, v19)
      if (v === 18 || v === 19) {
        const { data: imageTasks } = await supabase.from('image_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', true);
        if (!imageTasks || imageTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const allCompleted = imageTasks.every((t: any) => t.status === 'completed_final' || t.status === 'completed');
        return { ...base, scenario: allCompleted ? 'itv-image-folder-completed' : 'itv-image-folder-active' };
      }

      // ITV video prompts (v20, v21)
      if (v === 20 || v === 21) {
        const { data: promptTasks } = await supabase.from('ITV_prompt_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab).eq('itv', true);
        if (!promptTasks || promptTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const allCompleted = promptTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'itv-video-prompts-completed' : 'itv-video-prompts-active' };
      }

      // ITV folder (v22, v23)
      if (v === 22 || v === 23) {
        const { data: itvTasks } = await supabase.from('ITV_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!itvTasks || itvTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const allCompleted = itvTasks.every((t: any) => t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'itv-folder-completed' : 'itv-folder-active' };
      }

      // MG prompts (v24, v25) — mirror TTV-prompt resolution but against MG_prompt_tasks/MG_tasks.
      // No dedicated 'mg-*' scenarios exist yet, so reuse the TTV scenario tokens which carry the
      // same semantic ("prompts-only file with a downstream batch pipeline").
      if (v === 24 || v === 25) {
        const { data: promptTasks } = await supabase.from('MG_prompt_tasks')
          .select('id')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!promptTasks || promptTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const { data: mgTasks } = await supabase.from('MG_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!mgTasks || mgTasks.length === 0) return { ...base, scenario: 'ttv-prompts-completed' };
        const allCompleted = mgTasks.every((t: any) => t.status === 'completed' || t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'ttv-prompts-completed' : 'ttv-prompts-active' };
      }

      // MG folder (v26, v27)
      if (v === 26 || v === 27) {
        const { data: mgTasks } = await supabase.from('MG_tasks')
          .select('id, status')
          .eq('user_id', userId).eq('group_id', groupId).eq('tab', tab);
        if (!mgTasks || mgTasks.length === 0) return { ...base, scenario: 'simple-delete' };
        const allCompleted = mgTasks.every((t: any) => t.status === 'completed' || t.status === 'completed_final');
        return { ...base, scenario: allCompleted ? 'ttv-folder-completed' : 'ttv-folder-active' };
      }

      return { ...base, scenario: 'simple-delete' };
    } catch (err) {
      console.error('Error resolving doc scenario:', err);
      return { ...base, scenario: 'simple-delete' };
    }
  };

  const handleBulkDeleteClick = async () => {
    if (markedDocIds.size === 0) return;
    setBulkResolving(true);
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        setError('Authentication error');
        return;
      }
      // Compute deletion order: visible (top-to-bottom) -> filter marked -> reverse for bottom-to-top
      const ordered = getOrderedVisibleDocs().filter(d => markedDocIds.has(d.id));
      const bottomUp = [...ordered].reverse();
      // Resolve each scenario
      const states: DeleteConfirmModalState[] = [];
      for (const d of bottomUp) {
        const s = await resolveDocScenario(d, user.id);
        states.push(s);
      }
      // Determine worst (lowest severity rank)
      let worst: DeleteScenario = 'simple-delete';
      for (const s of states) {
        if (scenarioSeverity(s.scenario) < scenarioSeverity(worst)) worst = s.scenario;
      }
      setBulkDeleteModal({ states, worstScenario: worst });
    } catch (err: any) {
      console.error('Error preparing bulk delete:', err);
      setError(err.message || 'Failed to prepare bulk delete');
    } finally {
      setBulkResolving(false);
    }
  };

  const handleBulkConfirm = async () => {
    if (!bulkDeleteModal) return;
    const { states } = bulkDeleteModal;
    setBulkDeleting(true);
    setBulkProgress({ current: 0, total: states.length });
    try {
      for (let i = 0; i < states.length; i++) {
        const s = states[i];
        try {
          // Reuse the exact same single-delete pipeline so behavior matches manual deletion
          await handleConfirmDelete(s);
        } catch (err) {
          console.error('Bulk delete: failed for', s.doc.id, err);
          // Continue with the next file
        }
        setBulkProgress({ current: i + 1, total: states.length });
        // Remove from marked set as we go (UI feedback)
        setMarkedDocIds(prev => {
          const next = new Set(prev);
          next.delete(s.doc.id);
          return next;
        });
      }
    } finally {
      setBulkDeleting(false);
      setBulkProgress(null);
      setBulkDeleteModal(null);
    }
  };


  const handleViewImages = async (doc: StoryDocument) => {
    try {
      const folderPath = doc.file_path;
      let allFiles: any[] = [];
      const LIST_LIMIT = 100;
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: files, error: listError } = await supabase.storage
          .from('stories')
          .list(folderPath, { limit: LIST_LIMIT, offset });
        if (listError) {
          throw new Error(`Failed to list images: ${listError.message}`);
        }
        allFiles = allFiles.concat(files);
        if (files.length < LIST_LIMIT) {
          hasMore = false;
        } else {
          offset += LIST_LIMIT;
        }
      }
      const imageFiles = allFiles
        .filter(file => file.name.endsWith('.png'))
        .sort((a, b) => {
          const aNum = parseInt(a.name.split('.')[0]);
          const bNum = parseInt(b.name.split('.')[0]);
          return aNum - bNum;
        });
      if (imageFiles.length === 0) {
        setFolderImages([]);
        setSelectedFolder(doc);
        setIsModalOpen(true);
        return;
      }
      const signedUrls = await Promise.all(
        imageFiles.map(async (file) => {
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from('stories')
            .createSignedUrl(`${folderPath}/${file.name}`, 60);
          if (signedUrlError) {
            console.error(`Failed to generate signed URL for ${file.name}:`, signedUrlError);
            return null;
          }
          return signedUrlData.signedUrl;
        })
      );
      setFolderImages(signedUrls.filter((url): url is string => url !== null));
      setSelectedFolder(doc);
      setIsModalOpen(true);
    } catch (err: any) {
      console.error('Error in handleViewImages:', err);
      setError(err.message || 'Failed to load images');
    }
  };

  const handleViewVideos = async (doc: StoryDocument) => {
    try {
      setLoadingVideoFolder(true);
      setSelectedVideoFolder(doc);
      setIsVideoFolderModalOpen(true);
      setFolderVideos([]);

      const folderPath = doc.file_path;
      let allFiles: any[] = [];
      const LIST_LIMIT = 100;
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: files, error: listError } = await supabase.storage
          .from('stories')
          .list(folderPath, { limit: LIST_LIMIT, offset });
        if (listError) {
          throw new Error(`Failed to list videos: ${listError.message}`);
        }
        allFiles = allFiles.concat(files);
        if (files.length < LIST_LIMIT) {
          hasMore = false;
        } else {
          offset += LIST_LIMIT;
        }
      }
      const videoFiles = allFiles
        .filter(file => file.name.endsWith('.mp4'))
        .sort((a, b) => {
          const aNum = parseInt(a.name.split('.')[0]);
          const bNum = parseInt(b.name.split('.')[0]);
          return aNum - bNum;
        });
      if (videoFiles.length === 0) {
        setFolderVideos([]);
        return;
      }
      const signedUrls = await Promise.all(
        videoFiles.map(async (file) => {
          const fileSize: number = (file.metadata?.size as number) ?? 0;
          const expiry = fileSize >= LARGE_FILE_THRESHOLD ? 3600 : 300;
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from('stories')
            .createSignedUrl(`${folderPath}/${file.name}`, expiry);
          if (signedUrlError) {
            console.error(`Failed to generate signed URL for ${file.name}:`, signedUrlError);
            return null;
          }
          return { name: file.name, url: signedUrlData.signedUrl, size: fileSize };
        })
      );
      setFolderVideos(signedUrls.filter((v): v is { name: string; url: string; size: number } => v !== null));
    } catch (err: any) {
      console.error('Error in handleViewVideos:', err);
      setError(err.message || 'Failed to load videos');
      setIsVideoFolderModalOpen(false);
    } finally {
      setLoadingVideoFolder(false);
    }
  };

  const handleDownloadSingleVideo = async (folderPath: string, fileName: string, fileSize: number = 0) => {
    const key = `${folderPath}/${fileName}`;
    try {
      setDownloadingVideos(prev => ({ ...prev, [key]: true }));
      const isLargeClip = fileSize >= LARGE_FILE_THRESHOLD;
      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from('stories')
        .createSignedUrl(`${folderPath}/${fileName}`, isLargeClip ? 3600 : 300, { download: fileName });
      if (signedUrlError || !signedUrlData) {
        throw new Error(`Failed to generate signed URL for ${fileName}: ${signedUrlError?.message}`);
      }
      if (isLargeClip) {
        setLargeVideoDownloadModal({
          fileName,
          fileSizeBytes: fileSize,
          signedUrl: signedUrlData.signedUrl,
        });
      } else {
        const a = document.createElement('a');
        a.href = signedUrlData.signedUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err: any) {
      console.error(`Error downloading video clip ${fileName}:`, err);
      setError(err.message || `Failed to download video clip ${fileName}`);
    } finally {
      setDownloadingVideos(prev => ({ ...prev, [key]: false }));
    }
  };

  // Check if a document version is a text file (story, prompts, etc.)
  const isTextDocument = (version: number): boolean => {
    return [1, 2, 3, 4, 12, 13, 16, 17, 20, 21, 24, 25].includes(version);
  };

  // Check if a document version is a prompt file (should warn about editing only in prompt boxes)
  const isPromptDocument = (version: number): boolean => {
    return [3, 4, 12, 13, 16, 17, 20, 21, 24, 25].includes(version);
  };

  // Check if a document is a single audio file
  const isSingleAudioDocument = (version: number): boolean => {
    return version === 7 || version === 8;
  };

  // Check if a document is an audio folder
  const isAudioFolderDocument = (version: number): boolean => {
    return version === 9 || version === 10;
  };

  const handleViewTextFile = async (doc: StoryDocument) => {
    try {
      setTextPreviewLoading(true);
      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('stories')
        .createSignedUrl(doc.file_path, 300);
      if (signedUrlError || !signedUrlData) {
        throw new Error(`Failed to generate signed URL: ${signedUrlError?.message}`);
      }
      const response = await fetch(signedUrlData.signedUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: HTTP ${response.status}`);
      }
      const content = await response.text();
      setTextPreviewModal({
        doc,
        content,
        isEditing: false,
        editedContent: content,
        saving: false,
      });
    } catch (err: any) {
      console.error('Error fetching text file:', err);
      setError(err.message || 'Failed to load file content');
    } finally {
      setTextPreviewLoading(false);
    }
  };

  const handleSaveTextFile = async () => {
    if (!textPreviewModal) return;
    try {
      setTextPreviewModal(prev => prev ? { ...prev, saving: true } : null);
      const blob = new Blob([textPreviewModal.editedContent], { type: 'text/plain' });
      const { error: uploadError } = await supabase
        .storage
        .from('stories')
        .update(textPreviewModal.doc.file_path, blob, {
          contentType: 'text/plain',
          upsert: true,
        });
      if (uploadError) {
        throw new Error(`Failed to save file: ${uploadError.message}`);
      }
      // Update word count in DB
      const wordCount = textPreviewModal.editedContent.split(/\s+/).filter(Boolean).length;
      await supabase
        .from('story_documents')
        .update({ word_count: wordCount })
        .eq('id', textPreviewModal.doc.id);
      // Update local state
      setDocuments(prev => {
        const updated = { ...prev };
        Object.values(updated).forEach(group => {
          if (group.original?.id === textPreviewModal.doc.id) {
            group.original.word_count = wordCount;
          }
          group.relatedDocuments = group.relatedDocuments.map(d =>
            d.id === textPreviewModal.doc.id ? { ...d, word_count: wordCount } : d
          );
        });
        return updated;
      });
      setTextPreviewModal(prev => prev ? {
        ...prev,
        content: prev.editedContent,
        isEditing: false,
        saving: false,
      } : null);
    } catch (err: any) {
      console.error('Error saving text file:', err);
      setError(err.message || 'Failed to save file');
      setTextPreviewModal(prev => prev ? { ...prev, saving: false } : null);
    }
  };

  const handleViewSingleAudio = async (doc: StoryDocument) => {
    try {
      setAudioPreviewLoading(true);
      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('stories')
        .createSignedUrl(doc.file_path, 3600, { download: false });
      if (signedUrlError || !signedUrlData) {
        throw new Error(`Failed to generate signed URL: ${signedUrlError?.message}`);
      }
      setAudioPreviewModal({
        doc,
        audioFiles: [{
          name: doc.title,
          url: signedUrlData.signedUrl,
          filePath: doc.file_path,
        }],
      });
    } catch (err: any) {
      console.error('Error loading audio:', err);
      setError(err.message || 'Failed to load audio file');
    } finally {
      setAudioPreviewLoading(false);
    }
  };

  const handleViewAudioFolder = async (doc: StoryDocument) => {
    try {
      setAudioPreviewLoading(true);
      const folderPath = doc.file_path;
      let allFiles: any[] = [];
      const LIST_LIMIT = 100;
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: files, error: listError } = await supabase.storage
          .from('stories')
          .list(folderPath, { limit: LIST_LIMIT, offset });
        if (listError) {
          throw new Error(`Failed to list audio files: ${listError.message}`);
        }
        allFiles = allFiles.concat(files);
        if (files.length < LIST_LIMIT) {
          hasMore = false;
        } else {
          offset += LIST_LIMIT;
        }
      }
      const audioFiles = allFiles
        .filter(file => file.name.endsWith('.wav') || file.name.endsWith('.mp3'))
        .sort((a, b) => {
          const aNum = parseInt(a.name.split('.')[0]) || 0;
          const bNum = parseInt(b.name.split('.')[0]) || 0;
          return aNum - bNum;
        });
      const signedFiles = await Promise.all(
        audioFiles.map(async (file) => {
          const fullPath = `${folderPath}/${file.name}`;
          const { data: signedUrlData, error: signedUrlError } = await supabase.storage
            .from('stories')
            .createSignedUrl(fullPath, 3600, { download: false });
          if (signedUrlError || !signedUrlData) {
            console.error(`Failed to generate signed URL for ${file.name}:`, signedUrlError);
            return null;
          }
          return {
            name: file.name,
            url: signedUrlData.signedUrl,
            filePath: fullPath,
          };
        })
      );
      setAudioPreviewModal({
        doc,
        audioFiles: signedFiles.filter((f): f is { name: string; url: string; filePath: string } => f !== null),
      });
    } catch (err: any) {
      console.error('Error loading audio folder:', err);
      setError(err.message || 'Failed to load audio files');
    } finally {
      setAudioPreviewLoading(false);
    }
  };

  const handleViewFinalVideo = async (doc: StoryDocument) => {
    try {
      setVideoPreviewLoading(true);
      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from('videos')
        .createSignedUrl(doc.file_path, 3600);
      if (signedUrlError || !signedUrlData) {
        throw new Error(`Failed to generate signed URL: ${signedUrlError?.message}`);
      }
      setVideoPreviewModal({
        doc,
        videoUrl: signedUrlData.signedUrl,
      });
    } catch (err: any) {
      console.error('Error loading video:', err);
      setError(err.message || 'Failed to load video');
    } finally {
      setVideoPreviewLoading(false);
    }
  };

  const getDocumentLabel = (doc: StoryDocument, allRelatedDocs: StoryDocument[]): string => {
    let baseLabel = '';
    const version = doc.version || 0;
    if (version === 1) {
      baseLabel = 'Original Version';
    } else if (version === 2) {
      baseLabel = 'Corrected Version';
    } else if (version === 3) {
      baseLabel = 'Original Prompted Version';
    } else if (version === 4) {
      baseLabel = 'Corrected Prompted Version';
    } else if (version === 5) {
      baseLabel = 'Original Images';
    } else if (version === 6) {
      baseLabel = 'Corrected Images';
    } else if (version === 7) {
      baseLabel = 'Original Audio';
    } else if (version === 8) {
      baseLabel = 'Corrected Audio';
    } else if (version === 9) {
      baseLabel = 'Original Audio Folder';
    } else if (version === 10) {
      baseLabel = 'Corrected Audio Folder';
    } else if (version === 11) {
      if (doc.description === 'Final Video') {
        baseLabel = doc.title;
      } else {
        baseLabel = doc.description || 'Video';
      }
    } else if (version === 12) {
      baseLabel = 'Original TTV Prompts';
    } else if (version === 13) {
      baseLabel = 'Corrected TTV Prompts';
    } else if (version === 14) {
      baseLabel =
        doc.title?.startsWith('RF Outputs:') || doc.file_path?.includes('/RF-')
          ? 'Real Footage Clips'
          : 'Original TTV Videos';
    } else if (version === 15) {
      baseLabel = 'Corrected TTV Videos';
    } else if (version === 16) {
      baseLabel = 'ITV Image Prompts';
    } else if (version === 17) {
      baseLabel = 'Corrected ITV Image Prompts';
    } else if (version === 18) {
      baseLabel = 'ITV Images';
    } else if (version === 19) {
      baseLabel = 'Corrected ITV Images';
    } else if (version === 20) {
      baseLabel = 'ITV Video Prompts';
    } else if (version === 21) {
      baseLabel = 'Corrected ITV Video Prompts';
    } else if (version === 22) {
      baseLabel = 'ITV Videos';
    } else if (version === 23) {
      baseLabel = 'Corrected ITV Videos';
    } else if (version === 24) {
      baseLabel = 'MG Prompts';
    } else if (version === 25) {
      baseLabel = 'Corrected MG Prompts';
    } else if (version === 26) {
      baseLabel = 'MG Videos';
    } else if (version === 27) {
      baseLabel = 'Corrected MG Videos';
    } else {
      baseLabel = 'Unknown Version';
    }

    // Never add variant numbers for video folder types
    if (version === 14 || version === 15 || version === 22 || version === 23 || version === 26 || version === 27) {
      return baseLabel;
    }

    const sameTypeDocs = allRelatedDocs.filter(d => d.version === doc.version);
    if (sameTypeDocs.length > 1 && doc.variant !== undefined && doc.variant > 0) {
      return `${baseLabel} (${doc.variant})`;
    }
    return baseLabel;
  };

  const getLabelColor = (doc: StoryDocument): string => {
    const version = doc.version || 0;
    if (version === 1) {
      return 'text-text-muted';
    } else if (version === 2) {
      return 'text-status-success';
    } else if (version === 3 || version === 4) {
      return 'text-status-info';
    } else if (version === 5 || version === 6) {
      return 'text-status-success';
    } else if (version === 7 || version === 8) {
      return 'text-action-orange';
    } else if (version === 9 || version === 10) {
      return 'text-status-error';
    } else if (version === 11) {
      if (doc.description === 'Final Video') {
        return 'text-status-pending';
      } else {
        return 'text-text-muted';
      }
    } else if (version === 12 || version === 13) {
      return 'text-status-inactive';
    } else if (version === 14 || version === 15) {
      return 'text-status-pending';
    } else if (version === 16 || version === 17) {
      return 'text-status-inactive';
    } else if (version === 18 || version === 19) {
      return 'text-status-inactive';
    } else if (version === 20 || version === 21) {
      return 'text-status-paused';
    } else if (version === 22 || version === 23) {
      return 'text-status-paused';
    } else if (version === 24 || version === 25) {
      return 'text-status-inactive';
    } else if (version === 26 || version === 27) {
      return 'text-status-paused';
    }
    return 'text-text-dim';
  };

  const getContainerTitle = (doc: StoryDocument | null, relatedDocuments: StoryDocument[]): string => {
    const allDocs = doc ? [doc, ...relatedDocuments] : relatedDocuments;
    if (allDocs.length === 0) return 'Untitled Story';
    const originalDoc = allDocs.find(doc => doc.version === 1);
    if (originalDoc) {
      return originalDoc.title;
    }
    const firstDocTitle = allDocs[0].title;
    return firstDocTitle.replace(/\s*\(Corrected\)$/, '');
  };

  const groupMatchesFilter = (original: StoryDocument | null, related: StoryDocument[]): boolean => {
    if (filterType === 'all') return true;
    const allDocs = original ? [original, ...related] : related;
    return allDocs.some(d => d.version === 11 && d.description === 'Final Video');
  };

  const isAudioFile = (filePath: string): boolean => {
    return filePath.endsWith('.wav') || filePath.endsWith('.mp3');
  };

  const isVideoFile = (filePath: string): boolean => {
    return filePath.endsWith('.mp4') || filePath.endsWith('.mov') || filePath.endsWith('.avi');
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text"></div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        {/* Atmospheric gradient background */}
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
          <div className="absolute top-40 left-0 w-[40%] h-[300px] bg-[radial-gradient(ellipse_80%_80%_at_20%_50%,rgba(59,130,246,0.07)_0%,transparent_60%)]" />
          <div className="absolute top-60 right-0 w-[35%] h-[250px] bg-[radial-gradient(ellipse_80%_80%_at_80%_50%,rgba(34,197,94,0.06)_0%,transparent_60%)]" />
        </div>

        <div className="relative flex justify-between items-center mb-8 dash-animate-in-cinematic">
          <div>
            <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Your Documents</h1>
            <p className="mt-2 text-text-secondary">Access and download your generated stories, images, audio and video.</p>
          </div>
          {/* Storage progress badge */}
          {(() => {
            const limitMB = getStorageLimitMB(userPlan);
            const usedMB = storageUsed ?? 0;
            const pct = storageUsed !== null ? Math.min((usedMB / limitMB) * 100, 100) : 0;
            const barColor = pct >= 85 ? 'bg-accent' : pct >= 70 ? 'bg-action-orange' : 'bg-status-success';
            const textColor = pct >= 85 ? 'text-accent' : pct >= 70 ? 'text-action-orange' : 'text-status-success';
            return (
              <div className="bg-surface-card backdrop-blur-sm px-5 py-3 rounded-xl border border-border-card min-w-[200px]">
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-xs text-text-dim">Storage</span>
                  <span className={`text-xs font-medium tabular-nums ${textColor}`}>
                    {storageUsed !== null ? `${formatStorageSize(storageUsed)} / ${getStorageLimit(userPlan)}` : 'Calculating…'}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-surface-elevated rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${barColor}`}
                    style={{ width: storageUsed !== null ? `${pct}%` : '0%' }}
                  />
                </div>
              </div>
            );
          })()}
        </div>
        {/* Type filter chips */}
        <div className="flex items-center gap-2 mb-6 dash-animate-in-cinematic" style={{ animationDelay: '80ms' }}>
          {[
            { key: 'all' as const, label: 'All' },
            { key: 'final-video' as const, label: 'Final Video' },
          ].map(chip => (
            <button
              key={chip.key}
              onClick={() => setFilterType(chip.key)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filterType === chip.key
                  ? 'bg-accent text-white'
                  : 'bg-surface-card text-text-muted hover:text-white border border-border-card'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        {/* Mark-all / bulk delete controls */}
        {(() => {
          const visibleDocs = getOrderedVisibleDocs();
          const visibleIds = visibleDocs.map(d => d.id);
          const allMarked = visibleIds.length > 0 && visibleIds.every(id => markedDocIds.has(id));
          if (visibleDocs.length === 0) return null;
          return (
            <div className="flex items-center gap-2 mb-6 dash-animate-in-cinematic" style={{ animationDelay: '120ms' }}>
              <button
                onClick={handleMarkAllToggle}
                disabled={bulkResolving || bulkDeleting}
                className="flex items-center px-4 py-1.5 rounded-lg text-sm font-medium bg-surface-card text-text-muted hover:text-white border border-border-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {allMarked ? (
                  <CheckCircle2 className="h-4 w-4 mr-2 text-accent-text" />
                ) : (
                  <Circle className="h-4 w-4 mr-2" />
                )}
                {allMarked ? 'Unmark All' : 'Mark All'}
              </button>
              {markedDocIds.size > 0 && (
                <>
                  <span className="text-text-dim text-sm ml-1">{markedDocIds.size} selected</span>
                  <button
                    onClick={handleBulkDeleteClick}
                    disabled={bulkResolving || bulkDeleting}
                    className={`flex items-center px-4 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      bulkResolving || bulkDeleting
                        ? 'bg-accent/70 text-white cursor-not-allowed'
                        : 'bg-accent text-white hover:bg-accent-hover'
                    }`}
                  >
                    {bulkResolving ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                        Checking…
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete {markedDocIds.size} Marked
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          );
        })()}
        {error && (
          <div className="bg-status-error text-status-error p-4 rounded-xl mb-6">
            {error}
          </div>
        )}
        <div className="space-y-6">
          {Object.entries(documents).length === 0 ? (
            <div className="text-center py-12 bg-surface-card backdrop-blur-sm rounded-2xl border border-border-card">
              <FileText className="mx-auto h-12 w-12 text-text-dim" />
              <h3 className="mt-2 text-sm font-medium text-text-muted">No documents</h3>
              <p className="mt-1 text-sm text-text-dim">Get started by generating your first story or audio</p>
            </div>
          ) : (
            (() => {
              const filtered = Object.entries(documents)
                .filter(([_, { original, relatedDocuments }]) => groupMatchesFilter(original, relatedDocuments));
              if (filtered.length === 0) {
                return (
                  <div className="text-center py-12 bg-surface-card backdrop-blur-sm rounded-2xl border border-border-card">
                    <FileText className="mx-auto h-12 w-12 text-text-dim" />
                    <h3 className="mt-2 text-sm font-medium text-text-muted">No final video documents</h3>
                    <p className="mt-1 text-sm text-text-dim">
                      <button onClick={() => setFilterType('all')} className="text-accent-text hover:underline">Show all documents</button>
                    </p>
                  </div>
                );
              }
              return filtered.map(([groupId, { original, relatedDocuments }], index) => {
              const allDocs = original ? [original, ...relatedDocuments] : relatedDocuments;
              const totalCount = allDocs.length;
              const displayTitle = getContainerTitle(original, relatedDocuments);
              return (
                <div
                  key={groupId}
                  className="bg-surface-card backdrop-blur-sm rounded-2xl border border-border-card overflow-hidden dash-animate-in-cinematic"
                  style={{ animationDelay: `${Math.min(index * 55, 440)}ms` }}
                >
                  <div className="p-4 bg-surface-elevated border-b border-border">
                    <h2 className="text-lg font-medium text-white">
                      {displayTitle} {totalCount > 1 && `(${totalCount})`}
                    </h2>
                  </div>
                  <div className="p-6 space-y-4">
                    {original && (filterType === 'all' || (original.version === 11 && original.description === 'Final Video')) && (
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between">
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => toggleMarkDoc(original.id)}
                            disabled={bulkDeleting}
                            aria-label={markedDocIds.has(original.id) ? 'Unmark file' : 'Mark file'}
                            className="flex-shrink-0 mt-0.5 text-text-dim hover:text-accent-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {markedDocIds.has(original.id) ? (
                              <CheckCircle2 className="h-5 w-5 text-accent-text" />
                            ) : (
                              <Circle className="h-5 w-5" />
                            )}
                          </button>
                          <div>
                          <h3 className={`text-sm font-medium ${getLabelColor(original)}`}>
                            {(original.version === 5 || original.version === 6 || original.version === 18 || original.version === 19) ? (
                              <button
                                onClick={() => handleViewImages(original)}
                                className="flex items-center hover:underline"
                              >
                                <Folder className="h-4 w-4 mr-2" />
                                {getDocumentLabel(original, allDocs)}
                              </button>
                            ) : (original.version === 14 || original.version === 15 || original.version === 22 || original.version === 23 || original.version === 26 || original.version === 27) ? (
                              <button
                                onClick={() => handleViewVideos(original)}
                                className="flex items-center hover:underline"
                              >
                                <Folder className="h-4 w-4 mr-2" />
                                {getDocumentLabel(original, allDocs)}
                              </button>
                            ) : isTextDocument(original.version || 0) ? (
                              <button
                                onClick={() => handleViewTextFile(original)}
                                className="flex items-center hover:underline"
                              >
                                <FileText className="h-4 w-4 mr-2" />
                                {getDocumentLabel(original, allDocs)}
                              </button>
                            ) : isSingleAudioDocument(original.version || 0) ? (
                              <button
                                onClick={() => handleViewSingleAudio(original)}
                                className="flex items-center hover:underline"
                              >
                                <Music className="h-4 w-4 mr-2" />
                                {getDocumentLabel(original, allDocs)}
                              </button>
                            ) : isAudioFolderDocument(original.version || 0) ? (
                              <button
                                onClick={() => handleViewAudioFolder(original)}
                                className="flex items-center hover:underline"
                              >
                                <Folder className="h-4 w-4 mr-2" />
                                {getDocumentLabel(original, allDocs)}
                              </button>
                            ) : original.version === 11 ? (
                              <button
                                onClick={() => handleViewFinalVideo(original)}
                                className="flex items-center hover:underline"
                              >
                                <Film className="h-4 w-4 mr-2" />
                                {getDocumentLabel(original, allDocs)}
                              </button>
                            ) : (
                              <div className="flex items-center">
                                {getDocumentLabel(original, allDocs)}
                              </div>
                            )}
                          </h3>
                          <p className="text-sm text-text-dim">
                            Created on {formatDate(original.created_at)}
                          </p>
                          {/* Show file size for v5-11, v14-15, v18/v19, v22/v23, v26/v27; word count for text docs (incl. v12/v13 TTV, v16/v17/v20/v21 ITV, v24/v25 MG prompt docs) */}
                          {original.version && ((original.version >= 5 && original.version <= 11) || original.version === 14 || original.version === 15 || original.version === 18 || original.version === 19 || original.version === 22 || original.version === 23 || original.version === 26 || original.version === 27) ? (
                            original.file_size != null && (
                              <p className="text-sm text-text-dim">
                                {formatFileSize(original.file_size)}
                              </p>
                            )
                          ) : (
                            original.word_count != null && (
                              <p className="text-sm text-text-dim">
                                {original.word_count.toLocaleString()} words
                              </p>
                            )
                          )}
                        </div>
                        </div>
                        <div className="mt-2 sm:mt-0 sm:ml-0 flex space-x-2">
                          {(original.version === 5 || original.version === 6 || original.version === 9 || original.version === 10 || original.version === 14 || original.version === 15 || original.version === 18 || original.version === 19 || original.version === 22 || original.version === 23 || original.version === 26 || original.version === 27) ? (
                            <button
                              onClick={() => handleDownloadFolderAsZip(original, original.version === 9 || original.version === 10, original.version === 14 || original.version === 15 || original.version === 22 || original.version === 23 || original.version === 26 || original.version === 27)}
                              className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                                downloadingZips[original.id]
                                  ? 'bg-surface-elevated text-text-dim cursor-not-allowed'
                                  : 'bg-surface-elevated text-text-muted hover:bg-surface-elevated'
                              }`}
                              disabled={downloadingZips[original.id]}
                            >
                              {downloadingZips[original.id] ? (
                                zipFolderProgress[original.id] > 0 ? (
                                  <div className="flex items-center">
                                    <div className="w-24 bg-surface-elevated rounded-full h-2 mr-2">
                                      <div
                                        className="bg-status-info h-2 rounded-full transition-all duration-300"
                                        style={{ width: `${zipFolderProgress[original.id]}%` }}
                                      />
                                    </div>
                                    <span className="text-xs tabular-nums">{zipFolderProgress[original.id]}%</span>
                                  </div>
                                ) : (
                                  <>
                                    <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-border-subtle mr-2"></div>
                                    Preparing…
                                  </>
                                )
                              ) : (
                                <>
                                  <Download className="h-4 w-4 mr-2" />
                                  Download ZIP
                                </>
                              )}
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                if (original.version === 7 || original.version === 8) {
                                  handleDownloadSingleAudio(original);
                                } else if (original.version === 11) {
                                  handleDownloadVideo(original);
                                } else {
                                  handleDownload(original.file_path, original.title, isAudioFile(original.file_path));
                                }
                              }}
                              className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                                downloadingAudios[original.id]
                                  ? 'bg-surface-elevated text-text-dim cursor-not-allowed'
                                  : 'bg-surface-elevated text-text-muted hover:bg-surface-elevated'
                              }`}
                              disabled={downloadingAudios[original.id]}
                            >
                              {downloadingAudios[original.id] ? (
                                <>
                                  {/* Show progress bar for large videos (2GB+) */}
                                  {original.version === 11 && original.file_size && original.file_size >= LARGE_FILE_THRESHOLD && downloadProgress[original.id] > 0 ? (
                                    <div className="flex items-center">
                                      <div className="w-24 bg-surface-elevated rounded-full h-2 mr-2">
                                        <div 
                                          className="bg-status-info-muted h-2 rounded-full transition-all duration-300" 
                                          style={{width: `${downloadProgress[original.id] || 0}%`}}
                                        ></div>
                                      </div>
                                      <span className="text-xs">{downloadProgress[original.id] || 0}%</span>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-border-subtle mr-2"></div>
                                      Downloading...
                                    </>
                                  )}
                                </>
                              ) : (
                                <>
                                  <Download className="h-4 w-4 mr-2" />
                                  Download
                                </>
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (original.version === 1 || original.version === 2) {
                                handleStoryDeleteClick(original);
                              } else if (original.version === 3 || original.version === 4) {
                                handleImagePromptDeleteClick(original);
                              } else if (original.version === 5 || original.version === 6) {
                                handleImageFolderDeleteClick(original);
                              } else if (original.version === 7 || original.version === 8 || original.version === 9 || original.version === 10) {
                                handleAudioDeleteClick(original);
                              } else if (original.version === 11) {
                                handleVideoDeleteClick(original);
                              } else if (original.version === 12 || original.version === 13) {
                                handleTTVPromptDeleteClick(original);
                              } else if (original.version === 14 || original.version === 15) {
                                handleTTVFolderDeleteClick(original);
                              } else if (original.version === 16 || original.version === 17) {
                                handleITVImagePromptDeleteClick(original);
                              } else if (original.version === 18 || original.version === 19) {
                                handleITVImageFolderDeleteClick(original);
                              } else if (original.version === 20 || original.version === 21) {
                                handleITVVideoPromptDeleteClick(original);
                              } else if (original.version === 22 || original.version === 23) {
                                handleITVFolderDeleteClick(original);
                              } else {
                                handleSimpleDeleteClick(original);
                              }
                            }}
                            className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                              deletingDocs[original.id] || checkingDelete[original.id]
                                ? 'bg-accent/70 text-white cursor-not-allowed'
                                : 'bg-accent text-white hover:bg-accent-hover'
                            }`}
                            disabled={deletingDocs[original.id] || checkingDelete[original.id]}
                          >
                            {checkingDelete[original.id] ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                                Checking...
                              </>
                            ) : deletingDocs[original.id] ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                                Deleting...
                              </>
                            ) : (
                              <>
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                    {(filterType === 'final-video' ? relatedDocuments.filter(d => d.version === 11 && d.description === 'Final Video') : relatedDocuments).map((doc) => (
                      <div key={doc.id} className="flex flex-col sm:flex-row items-start sm:items-center justify-between">
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => toggleMarkDoc(doc.id)}
                            disabled={bulkDeleting}
                            aria-label={markedDocIds.has(doc.id) ? 'Unmark file' : 'Mark file'}
                            className="flex-shrink-0 mt-0.5 text-text-dim hover:text-accent-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {markedDocIds.has(doc.id) ? (
                              <CheckCircle2 className="h-5 w-5 text-accent-text" />
                            ) : (
                              <Circle className="h-5 w-5" />
                            )}
                          </button>
                          <div>
                          <h3 className={`text-sm font-medium ${getLabelColor(doc)}`}>
                            {(doc.version === 5 || doc.version === 6 || doc.version === 18 || doc.version === 19) ? (
                              <button
                                onClick={() => handleViewImages(doc)}
                                className="flex items-center hover:underline"
                              >
                                <Folder className="h-4 w-4 mr-2" />
                                {getDocumentLabel(doc, allDocs)}
                              </button>
                            ) : (doc.version === 14 || doc.version === 15 || doc.version === 22 || doc.version === 23 || doc.version === 26 || doc.version === 27) ? (
                              <button
                                onClick={() => handleViewVideos(doc)}
                                className="flex items-center hover:underline"
                              >
                                <Folder className="h-4 w-4 mr-2" />
                                {getDocumentLabel(doc, allDocs)}
                              </button>
                            ) : isTextDocument(doc.version || 0) ? (
                              <button
                                onClick={() => handleViewTextFile(doc)}
                                className="flex items-center hover:underline"
                              >
                                <FileText className="h-4 w-4 mr-2" />
                                {getDocumentLabel(doc, allDocs)}
                              </button>
                            ) : isSingleAudioDocument(doc.version || 0) ? (
                              <button
                                onClick={() => handleViewSingleAudio(doc)}
                                className="flex items-center hover:underline"
                              >
                                <Music className="h-4 w-4 mr-2" />
                                {getDocumentLabel(doc, allDocs)}
                              </button>
                            ) : isAudioFolderDocument(doc.version || 0) ? (
                              <button
                                onClick={() => handleViewAudioFolder(doc)}
                                className="flex items-center hover:underline"
                              >
                                <Folder className="h-4 w-4 mr-2" />
                                {getDocumentLabel(doc, allDocs)}
                              </button>
                            ) : doc.version === 11 ? (
                              <button
                                onClick={() => handleViewFinalVideo(doc)}
                                className="flex items-center hover:underline"
                              >
                                <Film className="h-4 w-4 mr-2" />
                                {getDocumentLabel(doc, allDocs)}
                              </button>
                            ) : (
                              <div className="flex items-center">
                                {getDocumentLabel(doc, allDocs)}
                              </div>
                            )}
                          </h3>
                          <p className="text-sm text-text-dim">
                            Created on {formatDate(doc.created_at)}
                          </p>
                          {/* Show file size for v5-11, v14-15, v18/v19, v22/v23, v26/v27; word count for text docs (incl. v12/v13 TTV, v16/v17/v20/v21 ITV, v24/v25 MG prompt docs) */}
                          {doc.version && ((doc.version >= 5 && doc.version <= 11) || doc.version === 14 || doc.version === 15 || doc.version === 18 || doc.version === 19 || doc.version === 22 || doc.version === 23 || doc.version === 26 || doc.version === 27) ? (
                            doc.file_size != null && (
                              <p className="text-sm text-text-dim">
                                {formatFileSize(doc.file_size)}
                              </p>
                            )
                          ) : (
                            doc.word_count != null && (
                              <p className="text-sm text-text-dim">
                                {doc.word_count.toLocaleString()} words
                              </p>
                            )
                          )}
                        </div>
                        </div>
                        <div className="mt-2 sm:mt-0 sm:ml-0 flex space-x-2">
                          {(doc.version === 5 || doc.version === 6 || doc.version === 9 || doc.version === 10 || doc.version === 14 || doc.version === 15 || doc.version === 18 || doc.version === 19 || doc.version === 22 || doc.version === 23 || doc.version === 26 || doc.version === 27) ? (
                            <button
                              onClick={() => handleDownloadFolderAsZip(doc, doc.version === 9 || doc.version === 10, doc.version === 14 || doc.version === 15 || doc.version === 22 || doc.version === 23 || doc.version === 26 || doc.version === 27)}
                              className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                                downloadingZips[doc.id]
                                  ? 'bg-surface-elevated text-text-dim cursor-not-allowed'
                                  : 'bg-surface-elevated text-text-muted hover:bg-surface-elevated'
                              }`}
                              disabled={downloadingZips[doc.id]}
                            >
                              {downloadingZips[doc.id] ? (
                                zipFolderProgress[doc.id] > 0 ? (
                                  <div className="flex items-center">
                                    <div className="w-24 bg-surface-elevated rounded-full h-2 mr-2">
                                      <div
                                        className="bg-status-info h-2 rounded-full transition-all duration-300"
                                        style={{ width: `${zipFolderProgress[doc.id]}%` }}
                                      />
                                    </div>
                                    <span className="text-xs tabular-nums">{zipFolderProgress[doc.id]}%</span>
                                  </div>
                                ) : (
                                  <>
                                    <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-border-subtle mr-2"></div>
                                    Preparing…
                                  </>
                                )
                              ) : (
                                <>
                                  <Download className="h-4 w-4 mr-2" />
                                  Download ZIP
                                </>
                              )}
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                if (doc.version === 7 || doc.version === 8) {
                                  handleDownloadSingleAudio(doc);
                                } else if (doc.version === 11) {
                                  handleDownloadVideo(doc);
                                } else {
                                  handleDownload(doc.file_path, doc.title, isAudioFile(doc.file_path));
                                }
                              }}
                              className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                                downloadingAudios[doc.id]
                                  ? 'bg-surface-elevated text-text-dim cursor-not-allowed'
                                  : 'bg-surface-elevated text-text-muted hover:bg-surface-elevated'
                              }`}
                              disabled={downloadingAudios[doc.id]}
                            >
                              {downloadingAudios[doc.id] ? (
                                <>
                                  {/* Show progress bar for large videos (2GB+) */}
                                  {doc.version === 11 && doc.file_size && doc.file_size >= LARGE_FILE_THRESHOLD && downloadProgress[doc.id] > 0 ? (
                                    <div className="flex items-center">
                                      <div className="w-24 bg-surface-elevated rounded-full h-2 mr-2">
                                        <div 
                                          className="bg-status-info-muted h-2 rounded-full transition-all duration-300" 
                                          style={{width: `${downloadProgress[doc.id] || 0}%`}}
                                        ></div>
                                      </div>
                                      <span className="text-xs">{downloadProgress[doc.id] || 0}%</span>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-border-subtle mr-2"></div>
                                      Downloading...
                                    </>
                                  )}
                                </>
                              ) : (
                                <>
                                  <Download className="h-4 w-4 mr-2" />
                                  Download
                                </>
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (doc.version === 1 || doc.version === 2) {
                                handleStoryDeleteClick(doc);
                              } else if (doc.version === 3 || doc.version === 4) {
                                handleImagePromptDeleteClick(doc);
                              } else if (doc.version === 5 || doc.version === 6) {
                                handleImageFolderDeleteClick(doc);
                              } else if (doc.version === 7 || doc.version === 8 || doc.version === 9 || doc.version === 10) {
                                handleAudioDeleteClick(doc);
                              } else if (doc.version === 11) {
                                handleVideoDeleteClick(doc);
                              } else if (doc.version === 12 || doc.version === 13) {
                                handleTTVPromptDeleteClick(doc);
                              } else if (doc.version === 14 || doc.version === 15) {
                                handleTTVFolderDeleteClick(doc);
                              } else if (doc.version === 16 || doc.version === 17) {
                                handleITVImagePromptDeleteClick(doc);
                              } else if (doc.version === 18 || doc.version === 19) {
                                handleITVImageFolderDeleteClick(doc);
                              } else if (doc.version === 20 || doc.version === 21) {
                                handleITVVideoPromptDeleteClick(doc);
                              } else if (doc.version === 22 || doc.version === 23) {
                                handleITVFolderDeleteClick(doc);
                              } else {
                                handleSimpleDeleteClick(doc);
                              }
                            }}
                            className={`flex items-center px-3 py-2 rounded-lg transition-colors ${
                              deletingDocs[doc.id] || checkingDelete[doc.id]
                                ? 'bg-accent/70 text-white cursor-not-allowed'
                                : 'bg-accent text-white hover:bg-accent-hover'
                            }`}
                            disabled={deletingDocs[doc.id] || checkingDelete[doc.id]}
                          >
                            {checkingDelete[doc.id] ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                                Checking...
                              </>
                            ) : deletingDocs[doc.id] ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                                Deleting...
                              </>
                            ) : (
                              <>
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            });
            })()
          )}
        </div>
        {bulkDeleteModal && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
            <div className="bg-surface-primary rounded-xl max-w-md w-full p-8 shadow-2xl border border-border">
              <div className="flex items-start mb-6">
                {isActiveScenario(bulkDeleteModal.worstScenario) ? (
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-status-warning/50 flex items-center justify-center mr-4">
                    <svg className="h-5 w-5 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                ) : (
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-status-error flex items-center justify-center mr-4">
                    <Trash2 className="h-5 w-5 text-status-error" />
                  </div>
                )}
                <div>
                  <h3 className="text-lg font-semibold text-white mb-2">
                    {isActiveScenario(bulkDeleteModal.worstScenario)
                      ? `Stop Active Generation & Delete ${bulkDeleteModal.states.length} File${bulkDeleteModal.states.length !== 1 ? 's' : ''}?`
                      : `Delete ${bulkDeleteModal.states.length} File${bulkDeleteModal.states.length !== 1 ? 's' : ''}?`}
                  </h3>
                  <p className="text-sm text-text-muted leading-relaxed">
                    {isActiveScenario(bulkDeleteModal.worstScenario) ? (
                      <>
                        <span className="text-status-warning font-medium">Warning:</span> One or more selected files have an active generation in progress. Deleting them will stop the generation and all unfinished progress will be lost. {bulkDeleteModal.states.length} file{bulkDeleteModal.states.length !== 1 ? 's' : ''} will be deleted one by one.
                      </>
                    ) : (
                      <>
                        Are you sure you want to delete {bulkDeleteModal.states.length} file{bulkDeleteModal.states.length !== 1 ? 's' : ''}? This action cannot be undone.
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setBulkDeleteModal(null)}
                  disabled={bulkDeleting}
                  className="px-4 py-2 rounded-lg bg-surface-elevated text-text-muted hover:bg-surface-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBulkConfirm}
                  disabled={bulkDeleting}
                  className={`flex items-center px-4 py-2 rounded-lg text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    isActiveScenario(bulkDeleteModal.worstScenario) ? 'bg-action-warning hover:bg-action-warning-hover' : 'bg-accent hover:bg-accent-hover'
                  }`}
                >
                  {bulkDeleting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                      Deleting {bulkProgress?.current ?? 0}/{bulkProgress?.total ?? bulkDeleteModal.states.length}…
                    </>
                  ) : (
                    `Yes, Delete ${bulkDeleteModal.states.length}`
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
        {deleteConfirmModal && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
            <div className="bg-surface-primary rounded-xl max-w-md w-full p-8 shadow-2xl border border-border">
              <div className="flex items-start mb-6">
                {(deleteConfirmModal.scenario === 'video-active' || deleteConfirmModal.scenario === 'image-generator-active' || deleteConfirmModal.scenario === 'image-folder-active' || deleteConfirmModal.scenario === 'audio-tts-active' || deleteConfirmModal.scenario === 'ttv-prompts-active' || deleteConfirmModal.scenario === 'ttv-folder-active' || deleteConfirmModal.scenario === 'itv-image-prompts-active' || deleteConfirmModal.scenario === 'itv-image-folder-active' || deleteConfirmModal.scenario === 'itv-video-prompts-active' || deleteConfirmModal.scenario === 'itv-folder-active') ? (
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-status-warning/50 flex items-center justify-center mr-4">
                    <svg className="h-5 w-5 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                ) : (
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-status-error flex items-center justify-center mr-4">
                    <Trash2 className="h-5 w-5 text-status-error" />
                  </div>
                )}
                <div>
                  <h3 className="text-lg font-semibold text-white mb-2">
                    {(deleteConfirmModal.scenario === 'video-active' || deleteConfirmModal.scenario === 'image-generator-active' || deleteConfirmModal.scenario === 'image-folder-active' || deleteConfirmModal.scenario === 'audio-tts-active' || deleteConfirmModal.scenario === 'ttv-prompts-active' || deleteConfirmModal.scenario === 'ttv-folder-active' || deleteConfirmModal.scenario === 'itv-image-prompts-active' || deleteConfirmModal.scenario === 'itv-image-folder-active' || deleteConfirmModal.scenario === 'itv-video-prompts-active' || deleteConfirmModal.scenario === 'itv-folder-active') ? 'Stop Active Generation & Delete?' : 'Delete File?'}
                  </h3>
                  <p className="text-sm text-text-muted leading-relaxed">
                    {deleteConfirmModal.scenario === 'simple-delete' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This action cannot be undone.</>
                    )}
                    {deleteConfirmModal.scenario === 'story-generator-only' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also clear the generation display in the Story Generator.</>
                    )}
                    {deleteConfirmModal.scenario === 'video-completed' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completed video generation display in the Video Generator.</>
                    )}
                    {deleteConfirmModal.scenario === 'video-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active video generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this file will stop the video generation and all unfinished progress will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'image-prompts-only' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completion screen from the Image Prompts page.</>
                    )}
                    {deleteConfirmModal.scenario === 'image-generator-completed' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completed image generation display in the Image Generator.</>
                    )}
                    {deleteConfirmModal.scenario === 'image-generator-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active image generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this file will stop the image generation and all unfinished progress will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'image-folder-completed' && (
                      <>Are you sure you want to delete the images folder <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completed image generation display in the Image Generator{deleteConfirmModal.imageFolderMode === 'new-prompts' ? ' (New Image Prompts workflow)' : ''}.</>
                    )}
                    {deleteConfirmModal.scenario === 'image-folder-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active image generation{deleteConfirmModal.imageFolderMode === 'new-prompts' ? ' (New Image Prompts workflow)' : ''} in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this folder will stop the image generation and all unfinished images will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'audio-tts-completed' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completion screen from the Text-To-Speech page.</>
                    )}
                    {deleteConfirmModal.scenario === 'audio-tts-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active audio generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this file will stop the audio generation and all unfinished audio files will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'video-file-completed' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completion screen from the Video Generator.</>
                    )}
                    {deleteConfirmModal.scenario === 'ttv-prompts-completed' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completion screen from the Text-To-Video page.</>
                    )}
                    {deleteConfirmModal.scenario === 'ttv-prompts-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active Text-To-Video generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this file will stop the generation and all unfinished video clips will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'ttv-folder-completed' && (
                      <>Are you sure you want to delete the TTV videos folder <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completion screen from the Text-To-Video page.</>
                    )}
                    {deleteConfirmModal.scenario === 'ttv-folder-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active Text-To-Video generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this folder will stop the generation and all unfinished video clips will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-image-prompts-completed' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the ITV image prompts generation display.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-image-prompts-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active ITV image prompt generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this file will stop the generation and all unfinished prompts will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-image-folder-completed' && (
                      <>Are you sure you want to delete the ITV images folder <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completed ITV image generation display.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-image-folder-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active ITV keyframe image generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this folder will stop the generation and all unfinished keyframe images will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-video-prompts-completed' && (
                      <>Are you sure you want to delete <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the ITV video prompts generation display.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-video-prompts-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active ITV video prompt generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this file will stop the generation and all unfinished prompts will be lost.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-folder-completed' && (
                      <>Are you sure you want to delete the ITV videos folder <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>? This will also remove the completed ITV video generation display.</>
                    )}
                    {deleteConfirmModal.scenario === 'itv-folder-active' && (
                      <><span className="text-status-warning font-medium">Warning:</span> There is an active ITV video generation in progress for <span className="text-white font-medium">"{deleteConfirmModal.doc.title}"</span>. Deleting this folder will stop the generation and all unfinished video clips will be lost.</>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setDeleteConfirmModal(null)}
                  disabled={confirmDeleting}
                  className="px-4 py-2 rounded-lg bg-surface-elevated text-text-muted hover:bg-surface-elevated transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleConfirmDelete()}
                  disabled={confirmDeleting}
                  className={`flex items-center px-4 py-2 rounded-lg text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    (deleteConfirmModal.scenario === 'video-active' || deleteConfirmModal.scenario === 'image-generator-active' || deleteConfirmModal.scenario === 'image-folder-active' || deleteConfirmModal.scenario === 'audio-tts-active' || deleteConfirmModal.scenario === 'ttv-prompts-active' || deleteConfirmModal.scenario === 'ttv-folder-active' || deleteConfirmModal.scenario === 'itv-image-prompts-active' || deleteConfirmModal.scenario === 'itv-image-folder-active' || deleteConfirmModal.scenario === 'itv-video-prompts-active' || deleteConfirmModal.scenario === 'itv-folder-active') ? 'bg-action-warning hover:bg-action-warning-hover' : 'bg-accent hover:bg-accent-hover'
                  }`}
                >
                  {confirmDeleting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                      Deleting...
                    </>
                  ) : (
                    'Yes, Delete'
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
        {isModalOpen && selectedFolder && (
          <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
            <div className="bg-surface-primary rounded-xl max-w-4xl w-full max-h-[85vh] overflow-y-auto p-8 shadow-2xl border border-border">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-semibold text-white tracking-tight">
                  {getDocumentLabel(selectedFolder, [])}
                </h2>
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="text-text-dim hover:text-white transition-colors"
                >
                  <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="space-y-6">
                {folderImages.length > 0 ? (
                  folderImages.map((url, index) => (
                    <div
                      key={index}
                      className="bg-surface-card rounded-lg p-4 border border-border shadow-md hover:shadow-lg transition-shadow"
                    >
                      <div className="flex justify-between items-center mb-3">
                        <h3 className="text-lg font-medium text-text-secondary">
                          {`${index + 1}. ${numberToOrdinal(index + 1)} Image`}
                        </h3>
                        <div className="flex space-x-2">
                          <button
                            onClick={() => handleDownloadSingleImage(`${selectedFolder.file_path}/${index + 1}.png`, `${index + 1}.png`, index)}
                            className={`flex items-center px-3 py-1 rounded-lg transition-colors ${
                              downloadingImages[index]
                                ? 'bg-surface-elevated text-text-dim cursor-not-allowed'
                                : 'bg-surface-elevated text-text-muted hover:bg-surface-elevated'
                            }`}
                            disabled={downloadingImages[index]}
                          >
                            {downloadingImages[index] ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-border-subtle mr-2"></div>
                                Downloading...
                              </>
                            ) : (
                              <>
                                <Download className="h-4 w-4 mr-2" />
                                Download
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <img
                        src={url}
                        alt={`${numberToOrdinal(index + 1)} Image`}
                        className="max-w-full h-auto rounded-md"
                      />
                    </div>
                  ))
                ) : (
                  <p className="text-text-dim text-center text-lg">No images found in this folder.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Video folder viewer modal (TTV v14/v15, ITV v22/v23) */}
      {isVideoFolderModalOpen && selectedVideoFolder && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-surface-primary rounded-xl max-w-4xl w-full max-h-[85vh] overflow-y-auto p-8 shadow-2xl border border-border">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-semibold text-white tracking-tight">
                {getDocumentLabel(selectedVideoFolder, [])}
              </h2>
              <button
                onClick={() => setIsVideoFolderModalOpen(false)}
                className="text-text-dim hover:text-white transition-colors"
              >
                <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {loadingVideoFolder ? (
              <div className="flex items-center justify-center py-16">
                <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-status-pending"></div>
                <span className="ml-3 text-text-dim">Loading clips…</span>
              </div>
            ) : (
              <div className="space-y-6">
                {folderVideos.length > 0 ? (
                  folderVideos.map((video, index) => {
                    const clipNumber = parseInt(video.name.split('.')[0]) || (index + 1);
                    const dlKey = `${selectedVideoFolder.file_path}/${video.name}`;
                    return (
                      <div
                        key={index}
                        className="bg-surface-card rounded-lg p-4 border border-border shadow-md hover:shadow-lg transition-shadow"
                      >
                        <div className="flex justify-between items-center mb-3">
                          <h3 className="text-lg font-medium text-text-secondary">
                            {`${clipNumber}. ${numberToOrdinal(clipNumber)} Clip`}
                          </h3>
                          <button
                            onClick={() => handleDownloadSingleVideo(selectedVideoFolder.file_path, video.name, video.size)}
                            className={`flex items-center px-3 py-1 rounded-lg transition-colors ${
                              downloadingVideos[dlKey]
                                ? 'bg-surface-elevated text-text-dim cursor-not-allowed'
                                : 'bg-surface-elevated text-text-muted hover:bg-surface-elevated'
                            }`}
                            disabled={downloadingVideos[dlKey]}
                          >
                            {downloadingVideos[dlKey] ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-border-subtle mr-2"></div>
                                Downloading...
                              </>
                            ) : (
                              <>
                                <Download className="h-4 w-4 mr-2" />
                                Download
                              </>
                            )}
                          </button>
                        </div>
                        <video
                          src={video.url}
                          controls
                          preload="metadata"
                          className="w-full rounded-md"
                        />
                      </div>
                    );
                  })
                ) : (
                  <p className="text-text-dim text-center text-lg">No video clips found in this folder.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Text file preview modal */}
      {textPreviewModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-surface-primary rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-border">
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-border flex-shrink-0">
              <div className="flex items-center space-x-3">
                <FileText className="h-5 w-5 text-text-muted" />
                <h2 className="text-xl font-semibold text-white tracking-tight">
                  {getDocumentLabel(textPreviewModal.doc, [])}
                </h2>
              </div>
              <button
                onClick={() => setTextPreviewModal(null)}
                className="text-text-dim hover:text-white transition-colors"
                aria-label="Close"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Content area */}
            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
              {/* Warning banner */}
              <div className="bg-status-warning border border-status-warning rounded-xl px-4 py-3 mb-4">
                <div className="flex items-start space-x-2">
                  <AlertTriangle className="h-5 w-5 text-status-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-status-warning-text text-sm">
                      Editing this file directly can interfere with ongoing or future generation processes. Changes are not recommended unless you know what you are doing.
                    </p>
                    {isPromptDocument(textPreviewModal.doc.version || 0) && (
                      <p className="text-status-warning-text text-sm mt-1.5">
                        <strong>Prompt files should only be edited within the prompt boxes:</strong>{' '}
                        {(textPreviewModal.doc.version === 3 || textPreviewModal.doc.version === 4) && (
                          <span className="text-status-warning">[Image Prompt: (Edit the text here if needed)]</span>
                        )}
                        {(textPreviewModal.doc.version === 12 || textPreviewModal.doc.version === 13) && (
                          <span className="text-status-warning">[Video Prompt: (Edit the text here if needed)]</span>
                        )}
                        {(textPreviewModal.doc.version === 16 || textPreviewModal.doc.version === 17) && (
                          <span className="text-status-warning">[ITV Image Prompt: (Edit the text here if needed)]</span>
                        )}
                        {(textPreviewModal.doc.version === 20 || textPreviewModal.doc.version === 21) && (
                          <span className="text-status-warning">[ITV Video Prompt: (Edit the text here if needed)]</span>
                        )}
                        {(textPreviewModal.doc.version === 24 || textPreviewModal.doc.version === 25) && (
                          <span className="text-status-warning">[MG Prompt: (Edit the text here if needed)]</span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {textPreviewModal.isEditing ? (
                <textarea
                  value={textPreviewModal.editedContent}
                  onChange={(e) => setTextPreviewModal(prev => prev ? { ...prev, editedContent: e.target.value } : null)}
                  className="w-full h-full min-h-[400px] bg-surface-input border border-border rounded-lg p-4 text-text-secondary text-sm font-mono leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
                  spellCheck={false}
                />
              ) : (
                <div className="bg-surface-card border border-border-card rounded-lg p-5">
                  <pre className="text-text-secondary text-sm font-mono leading-relaxed whitespace-pre-wrap break-words">
                    {textPreviewModal.content}
                  </pre>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-between items-center p-6 border-t border-border flex-shrink-0">
              <div className="text-sm text-text-dim">
                {textPreviewModal.doc.word_count?.toLocaleString() ?? '—'} words
              </div>
              <div className="flex items-center space-x-3">
                {textPreviewModal.isEditing ? (
                  <>
                    <button
                      onClick={() => setTextPreviewModal(prev => prev ? { ...prev, isEditing: false, editedContent: prev.content } : null)}
                      className="px-4 py-2 rounded-lg bg-surface-elevated text-text-muted hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveTextFile}
                      disabled={textPreviewModal.saving}
                      className="flex items-center px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {textPreviewModal.saving ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white mr-2"></div>
                          Saving...
                        </>
                      ) : (
                        'Save Changes'
                      )}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setTextPreviewModal(prev => prev ? { ...prev, isEditing: true } : null)}
                    className="flex items-center px-4 py-2 rounded-lg bg-surface-elevated text-text-muted hover:text-white transition-colors border border-border"
                  >
                    <Pencil className="h-4 w-4 mr-2" />
                    Edit
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Audio preview modal */}
      {audioPreviewModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-surface-primary rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-border">
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-border flex-shrink-0">
              <div className="flex items-center space-x-3">
                <Music className="h-5 w-5 text-action-orange" />
                <h2 className="text-xl font-semibold text-white tracking-tight">
                  {getDocumentLabel(audioPreviewModal.doc, [])}
                </h2>
              </div>
              <button
                onClick={() => setAudioPreviewModal(null)}
                className="text-text-dim hover:text-white transition-colors"
                aria-label="Close"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Audio files */}
            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-4">
              {audioPreviewModal.audioFiles.length > 0 ? (
                audioPreviewModal.audioFiles.map((audio, index) => (
                  <div key={index}>
                    {audioPreviewModal.audioFiles.length > 1 && (
                      <p className="text-sm font-medium text-text-muted mb-2">
                        {`${index + 1}. ${numberToOrdinal(index + 1)} Audio`}
                      </p>
                    )}
                    <AudioPlayer
                      src={audio.url}
                      title={audio.name}
                      filePath={audio.filePath}
                      onError={(err) => console.error('Audio player error:', err)}
                    />
                  </div>
                ))
              ) : (
                <p className="text-text-dim text-center text-lg py-8">No audio files found.</p>
              )}
            </div>

            {/* Footer info */}
            <div className="flex justify-between items-center p-6 border-t border-border flex-shrink-0">
              <div className="text-sm text-text-dim">
                {audioPreviewModal.audioFiles.length} audio file{audioPreviewModal.audioFiles.length !== 1 ? 's' : ''}
              </div>
              <button
                onClick={() => setAudioPreviewModal(null)}
                className="px-4 py-2 rounded-lg bg-surface-elevated text-text-muted hover:text-white transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Video preview modal */}
      {videoPreviewModal && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-surface-primary rounded-xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl border border-border">
            {/* Header */}
            <div className="flex justify-between items-center px-6 py-3 border-b border-border flex-shrink-0">
              <div className="flex items-center space-x-3">
                <Film className="h-5 w-5 text-status-pending" />
                <h2 className="text-xl font-semibold text-white tracking-tight">
                  {getDocumentLabel(videoPreviewModal.doc, [])}
                </h2>
              </div>
              <button
                onClick={() => setVideoPreviewModal(null)}
                className="text-text-dim hover:text-white transition-colors"
                aria-label="Close"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Video player */}
            <div className="flex-1 min-h-0 px-6 py-3 flex items-center justify-center">
              <video
                src={videoPreviewModal.videoUrl}
                controls
                autoPlay
                preload="metadata"
                className="w-full max-h-[calc(85vh-130px)] rounded-lg object-contain"
              />
            </div>

            {/* Footer */}
            <div className="flex justify-between items-center px-6 py-3 border-t border-border flex-shrink-0">
              <div className="text-sm text-text-dim">
                {videoPreviewModal.doc.file_size != null && formatFileSize(videoPreviewModal.doc.file_size)}
              </div>
              <div className="flex items-center space-x-3">
                <button
                  onClick={() => {
                    handleDownloadVideo(videoPreviewModal.doc);
                  }}
                  className="flex items-center px-4 py-2 rounded-lg bg-surface-elevated text-text-muted hover:text-white transition-colors border border-border"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download
                </button>
                <button
                  onClick={() => setVideoPreviewModal(null)}
                  className="px-4 py-2 rounded-lg bg-surface-elevated text-text-muted hover:text-white transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loading overlay for text/audio/video preview */}
      {(textPreviewLoading || audioPreviewLoading || videoPreviewLoading) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-surface-primary rounded-xl p-8 flex items-center space-x-4 border border-border">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-accent"></div>
            <span className="text-text-muted">{textPreviewLoading ? 'Loading file content…' : audioPreviewLoading ? 'Loading audio…' : 'Loading video…'}</span>
          </div>
        </div>
      )}

      {/* Large file download info modal */}
      {largeVideoDownloadModal && (
        <LargeVideoDownloadModal
          fileName={largeVideoDownloadModal.fileName}
          fileSizeBytes={largeVideoDownloadModal.fileSizeBytes}
          signedUrl={largeVideoDownloadModal.signedUrl}
          onClose={() => setLargeVideoDownloadModal(null)}
        />
      )}
    </DashboardLayout>
  );
}


