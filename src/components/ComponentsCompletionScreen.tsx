import React, { useState, useEffect } from 'react';
import { CheckCircle2, Download, RefreshCw, AlertCircle, Volume2, FileText, Image, Folder, Edit } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import AudioPlayer from './AudioPlayer';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface ComponentsCompletionScreenProps {
  videoTasks: any[];
  settings: any;
  currentUserId: string | null;
  currentGroupId: string | null;
  handleDone: () => Promise<void>;
}

interface AudioInfo {
  url: string | null;
  filePath: string;
  title: string;
  outputType: 'single' | 'folder';
}

interface StoryInfo {
  title: string;
  filePath: string;
  wordCount?: number;
}

interface ImagePromptInfo {
  title: string;
  filePath: string;
  wordCount?: number;
}

interface ImagesInfo {
  folderPath: string;
  imageCount: number;
  title: string;
}

const ComponentsCompletionScreen: React.FC<ComponentsCompletionScreenProps> = ({
  videoTasks,
  settings,
  currentUserId,
  currentGroupId,
  handleDone
}) => {
  const [audioInfo, setAudioInfo] = useState<AudioInfo | null>(null);
  const [storyInfo, setStoryInfo] = useState<StoryInfo | null>(null);
  const [imagePromptInfo, setImagePromptInfo] = useState<ImagePromptInfo | null>(null);
  const [imagesInfo, setImagesInfo] = useState<ImagesInfo | null>(null);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingAudio, setDownloadingAudio] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);

  // Get the main video task settings
  const mainTask = videoTasks.find(task => task.is_main) || videoTasks.find(task => !task.doc_id) || videoTasks[0];
  const taskSettings = mainTask?.settings || {};
  
  const processStory = taskSettings.process_story !== false;
  const processImages = taskSettings.process_images !== false;
  const processAudio = taskSettings.process_audio !== false;

  useEffect(() => {
    loadComponentsInfo();
  }, [currentUserId, currentGroupId]);

  const loadComponentsInfo = async () => {
    if (!currentUserId || !currentGroupId) return;

    try {
      setLoading(true);
      setError(null);

      // Load story info if story processing was enabled
      if (processStory) {
        await loadStoryInfo();
      }

      // Load audio info if audio processing was enabled
      if (processAudio) {
        await loadAudioInfo();
      }

      // Load image prompt info if image processing was enabled
      if (processImages) {
        await loadImagePromptInfo();
      }

      // Load images info if image processing was enabled
      if (processImages) {
        await loadImagesInfo();
      }

    } catch (err: any) {
      console.error('Error loading components info:', err);
      setError(`Failed to load components: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const loadAudioInfo = async () => {
    try {
      // Find audio document
      const { data: audioDoc, error: audioError } = await supabase
        .from('story_documents')
        .select('file_path, title, version')
        .eq('group_id', currentGroupId)
        .eq('user_id', currentUserId)
        .in('version', [7, 8, 9, 10])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (audioError) {
        console.error('Audio document not found:', audioError);
        return;
      }

      const isSingleFile = [7, 8].includes(audioDoc.version);
      let audioUrl = null;

      if (isSingleFile) {
        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from('stories')
          .createSignedUrl(audioDoc.file_path, 3600, { download: false });

        if (!signedUrlError && signedUrlData) {
          audioUrl = signedUrlData.signedUrl;
        }
      }

      setAudioInfo({
        url: audioUrl,
        filePath: audioDoc.file_path,
        title: audioDoc.title,
        outputType: isSingleFile ? 'single' : 'folder'
      });
    } catch (err: any) {
      console.error('Error loading audio info:', err);
    }
  };

  const loadStoryInfo = async () => {
    try {
      // Find story document (original or corrected version)
      const { data: storyDoc, error: storyError } = await supabase
        .from('story_documents')
        .select('file_path, title, word_count, version')
        .eq('group_id', currentGroupId)
        .eq('user_id', currentUserId)
        .in('version', [1, 2]) // Original or corrected story
        .order('version', { ascending: false }) // Prefer corrected version
        .limit(1)
        .single();

      if (storyError) {
        console.error('Story document not found:', storyError);
        return;
      }

      setStoryInfo({
        title: storyDoc.title,
        filePath: storyDoc.file_path,
        wordCount: storyDoc.word_count
      });
    } catch (err: any) {
      console.error('Error loading story info:', err);
    }
  };

  const loadImagePromptInfo = async () => {
    try {
      // Find image prompt document (version 3 or 4)
      const { data: promptDoc, error: promptError } = await supabase
        .from('story_documents')
        .select('file_path, title, word_count, version')
        .eq('group_id', currentGroupId)
        .eq('user_id', currentUserId)
        .in('version', [3, 4]) // Image prompt versions
        .order('version', { ascending: false }) // Prefer version 4 if available
        .limit(1)
        .single();

      if (promptError) {
        console.error('Image prompt document not found:', promptError);
        return;
      }

      setImagePromptInfo({
        title: promptDoc.title,
        filePath: promptDoc.file_path,
        wordCount: promptDoc.word_count
      });
    } catch (err: any) {
      console.error('Error loading image prompt info:', err);
    }
  };

  const loadImagesInfo = async () => {
    try {
      setLoadingImages(true);
      
      // Find image folder document
      const { data: imageDoc, error: imageError } = await supabase
        .from('story_documents')
        .select('file_path, title, version')
        .eq('group_id', currentGroupId)
        .eq('user_id', currentUserId)
        .in('version', [5, 6]) // Image folder versions
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (imageError) {
        console.error('Image folder not found:', imageError);
        return;
      }

      // Count images in folder and get file list
      const { data: files, error: listError } = await supabase.storage
        .from('stories')
        .list(imageDoc.file_path);

      let imageCount = 0;
      const imageFiles: any[] = [];
      if (!listError && files) {
        const filteredFiles = files.filter(file => 
          file.name.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/i)
        );
        imageCount = filteredFiles.length;
        imageFiles.push(...filteredFiles);
      }

      setImagesInfo({
        folderPath: imageDoc.file_path,
        imageCount,
        title: imageDoc.title
      });

      // Generate signed URLs for images
      if (imageFiles.length > 0) {
        // Sort image files by filename (1.png, 2.png, etc.)
        const sortedFiles = imageFiles.sort((a, b) => {
          const aNum = parseInt(a.name.split('.')[0]) || 0;
          const bNum = parseInt(b.name.split('.')[0]) || 0;
          return aNum - bNum;
        });

        const signedUrls = await Promise.all(
          sortedFiles.map(async (file) => {
            try {
              const { data: signedUrlData, error: signedUrlError } = await supabase.storage
                .from('stories')
                .createSignedUrl(`${imageDoc.file_path}/${file.name}`, 3600);

              if (signedUrlError) {
                console.error(`Failed to generate signed URL for ${file.name}:`, signedUrlError);
                return null;
              }
              return signedUrlData.signedUrl;
            } catch (error) {
              console.error(`Error creating signed URL for ${file.name}:`, error);
              return null;
            }
          })
        );

        const validUrls = signedUrls.filter((url): url is string => url !== null);
        setGeneratedImages(validUrls);
      }
    } catch (err: any) {
      console.error('Error loading images info:', err);
    } finally {
      setLoadingImages(false);
    }
  };

  const handleDownloadAudio = async () => {
    if (!audioInfo) return;

    try {
      setDownloadingAudio(true);

      if (audioInfo.outputType === 'single' && audioInfo.url) {
        // Single file download
        const response = await fetch(audioInfo.url);
        if (!response.ok) throw new Error('Failed to fetch audio');
        const blob = await response.blob();

        const fileExtension = audioInfo.filePath.split('.').pop()?.toLowerCase() || 'mp3';
        let fileName = audioInfo.title;

        if (fileName.includes('.')) {
          fileName = fileName.substring(0, fileName.lastIndexOf('.'));
        }
        fileName = `${fileName}.${fileExtension}`;

        saveAs(blob, fileName);
      } else {
        // Folder download - create ZIP
        const folderPath = audioInfo.filePath;

        const { data: fileList, error: listError } = await supabase.storage
          .from('stories')
          .list(folderPath, { limit: 100, offset: 0 });

        if (listError || !fileList) {
          throw new Error(`Failed to list files in folder: ${listError?.message || 'Unknown error'}`);
        }

        const audioFiles = fileList.filter(file =>
          file.name.endsWith('.mp3') || file.name.endsWith('.wav')
        );

        if (audioFiles.length === 0) {
          throw new Error('No audio files found in the folder');
        }

        const zip = new JSZip();

        for (const file of audioFiles) {
          const filePath = `${folderPath}/${file.name}`;
          const { data: fileData, error: downloadError } = await supabase.storage
            .from('stories')
            .download(filePath);

          if (downloadError) {
            console.error(`Failed to download ${file.name}:`, downloadError);
            continue;
          }

          const arrayBuffer = await fileData.arrayBuffer();
          zip.file(file.name, arrayBuffer);
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const zipFileName = `${audioInfo.title.replace(/[^a-zA-Z0-9\s-]/g, '')}_audio_files.zip`;
        saveAs(zipBlob, zipFileName);
      }
    } catch (err: any) {
      console.error('Download error:', err);
      setError(`Failed to download audio: ${err.message}`);
    } finally {
      setDownloadingAudio(false);
    }
  };

  const handleDownloadStory = async () => {
    if (!storyInfo) return;

    try {
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('stories')
        .download(storyInfo.filePath);

      if (downloadError) {
        throw new Error(`Failed to download story: ${downloadError.message}`);
      }

      const fileName = `${storyInfo.title}.txt`;
      saveAs(fileData, fileName);
    } catch (err: any) {
      console.error('Story download error:', err);
      setError(`Failed to download story: ${err.message}`);
    }
  };

  const handleDownloadImagePrompt = async () => {
    if (!imagePromptInfo) return;

    try {
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('stories')
        .download(imagePromptInfo.filePath);

      if (downloadError) {
        throw new Error(`Failed to download image prompts: ${downloadError.message}`);
      }

      const fileName = `${imagePromptInfo.title}.txt`;
      saveAs(fileData, fileName);
    } catch (err: any) {
      console.error('Image prompt download error:', err);
      setError(`Failed to download image prompts: ${err.message}`);
    }
  };

  const handleDownloadImages = async () => {
    if (!imagesInfo) return;

    try {
      const { data: fileList, error: listError } = await supabase.storage
        .from('stories')
        .list(imagesInfo.folderPath, { limit: 100, offset: 0 });

      if (listError || !fileList) {
        throw new Error(`Failed to list images: ${listError?.message || 'Unknown error'}`);
      }

      const imageFiles = fileList.filter(file =>
        file.name.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/i)
      );

      if (imageFiles.length === 0) {
        throw new Error('No image files found');
      }

      const zip = new JSZip();

      for (const file of imageFiles) {
        const filePath = `${imagesInfo.folderPath}/${file.name}`;
        const { data: fileData, error: downloadError } = await supabase.storage
          .from('stories')
          .download(filePath);

        if (downloadError) {
          console.error(`Failed to download ${file.name}:`, downloadError);
          continue;
        }

        const arrayBuffer = await fileData.arrayBuffer();
        zip.file(file.name, arrayBuffer);
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipFileName = `${imagesInfo.title.replace(/[^a-zA-Z0-9\s-]/g, '')}_images.zip`;
      saveAs(zipBlob, zipFileName);
    } catch (err: any) {
      console.error('Images download error:', err);
      setError(`Failed to download images: ${err.message}`);
    }
  };

  const handleDownloadAll = async () => {
    try {
      setDownloadingAll(true);
      const zip = new JSZip();

      // Add story file
      if (storyInfo) {
        try {
          const { data: storyData, error: storyError } = await supabase.storage
            .from('stories')
            .download(storyInfo.filePath);

          if (!storyError && storyData) {
            const storyBuffer = await storyData.arrayBuffer();
            zip.file(`story/${storyInfo.title}.txt`, storyBuffer);
          }
        } catch (err) {
          console.error('Error adding story to ZIP:', err);
        }
      }

      // Add audio files
      if (audioInfo) {
        try {
          if (audioInfo.outputType === 'single' && audioInfo.url) {
            const response = await fetch(audioInfo.url);
            if (response.ok) {
              const audioBuffer = await response.arrayBuffer();
              const fileExtension = audioInfo.filePath.split('.').pop()?.toLowerCase() || 'mp3';
              zip.file(`audio/${audioInfo.title}.${fileExtension}`, audioBuffer);
            }
          } else {
            const { data: audioFileList, error: audioListError } = await supabase.storage
              .from('stories')
              .list(audioInfo.filePath, { limit: 100, offset: 0 });

            if (!audioListError && audioFileList) {
              const audioFiles = audioFileList.filter(file =>
                file.name.endsWith('.mp3') || file.name.endsWith('.wav')
              );

              for (const file of audioFiles) {
                const filePath = `${audioInfo.filePath}/${file.name}`;
                const { data: fileData, error: downloadError } = await supabase.storage
                  .from('stories')
                  .download(filePath);

                if (!downloadError && fileData) {
                  const arrayBuffer = await fileData.arrayBuffer();
                  zip.file(`audio/${file.name}`, arrayBuffer);
                }
              }
            }
          }
        } catch (err) {
          console.error('Error adding audio to ZIP:', err);
        }
      }

      // Add image prompt file
      if (imagePromptInfo) {
        try {
          const { data: promptData, error: promptError } = await supabase.storage
            .from('stories')
            .download(imagePromptInfo.filePath);

          if (!promptError && promptData) {
            const promptBuffer = await promptData.arrayBuffer();
            zip.file(`image_prompts/${imagePromptInfo.title}.txt`, promptBuffer);
          }
        } catch (err) {
          console.error('Error adding image prompts to ZIP:', err);
        }
      }

      // Add image files
      if (imagesInfo) {
        try {
          const { data: imageFileList, error: imageListError } = await supabase.storage
            .from('stories')
            .list(imagesInfo.folderPath, { limit: 100, offset: 0 });

          if (!imageListError && imageFileList) {
            const imageFiles = imageFileList.filter(file =>
              file.name.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/i)
            );

            for (const file of imageFiles) {
              const filePath = `${imagesInfo.folderPath}/${file.name}`;
              const { data: fileData, error: downloadError } = await supabase.storage
                .from('stories')
                .download(filePath);

              if (!downloadError && fileData) {
                const arrayBuffer = await fileData.arrayBuffer();
                zip.file(`images/${file.name}`, arrayBuffer);
              }
            }
          }
        } catch (err) {
          console.error('Error adding images to ZIP:', err);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipFileName = `${settings.storyTitle || 'content'}_all_components.zip`;
      saveAs(zipBlob, zipFileName);
    } catch (err: any) {
      console.error('Download all error:', err);
      setError(`Failed to download all components: ${err.message}`);
    } finally {
      setDownloadingAll(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-lg p-6">
        <div className="flex items-center justify-center min-h-[200px]">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-status-success text-status-success p-4 rounded-lg">
        <div className="flex items-center space-x-2 text-status-success mb-2">
          <CheckCircle2 className="h-5 w-5" />
          <h3 className="text-base sm:text-lg font-medium">Content Generation Complete!</h3>
        </div>
        <p className="text-sm sm:text-base">
          Your content components have been successfully generated and are ready for use.
        </p>
      </div>

      {error && (
        <div className="bg-status-error text-status-error p-4 rounded-lg">
          <div className="flex items-center space-x-2 text-status-error mb-2">
            <AlertCircle className="h-5 w-5" />
            <h3 className="text-base font-medium">Error</h3>
          </div>
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="bg-surface-card rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-base sm:text-lg font-medium text-white">
              {settings.storyTitle || 'Your Content'}
            </h3>
            <p className="text-xs sm:text-sm text-text-dim">
              Generated components ready for download
            </p>
          </div>
          <button
            onClick={handleDownloadAll}
            disabled={downloadingAll}
            className="flex items-center px-4 py-2 bg-action-info text-white rounded-lg hover:bg-action-info-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
          >
            {downloadingAll ? (
              <>
                <RefreshCw className="animate-spin h-4 w-4 mr-2" />
                Creating ZIP...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Download All
              </>
            )}
          </button>
        </div>

        <div className="space-y-4">
          {/* Story Section */}
          {processStory && storyInfo && (
            <div className="bg-surface-elevated rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="flex items-center justify-center w-10 h-10 bg-action-info rounded-full">
                    <FileText className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h4 className="text-white font-medium">Story</h4>
                    <p className="text-text-dim text-sm">
                      {storyInfo.title} • {storyInfo.wordCount ? `${storyInfo.wordCount.toLocaleString()} words` : 'Text file'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleDownloadStory}
                  className="flex items-center px-3 py-1 bg-action-info text-white rounded-lg hover:bg-action-info-hover text-sm"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Download
                </button>
              </div>
            </div>
          )}

          {/* Audio Section */}
          {processAudio && audioInfo && (
            <div className="bg-surface-elevated rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center space-x-3">
                  <div className="flex items-center justify-center w-10 h-10 bg-action-success rounded-full">
                    <Volume2 className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h4 className="text-white font-medium">Audio</h4>
                    <p className="text-text-dim text-sm">
                      {audioInfo.title} • {audioInfo.outputType === 'single' ? 'Single file' : 'Multiple files'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleDownloadAudio}
                  disabled={downloadingAudio}
                  className="flex items-center px-3 py-1 bg-action-success text-white rounded-lg hover:bg-action-success-hover disabled:opacity-50 text-sm"
                >
                  {downloadingAudio ? (
                    <>
                      <RefreshCw className="animate-spin h-4 w-4 mr-1" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4 mr-1" />
                      Download {audioInfo.outputType === 'folder' ? 'ZIP' : ''}
                    </>
                  )}
                </button>
              </div>

              {audioInfo.outputType === 'single' && audioInfo.url ? (
                <AudioPlayer
                  src={audioInfo.url}
                  title={audioInfo.title}
                  filePath={audioInfo.filePath}
                  onError={(error) => setError(error)}
                />
              ) : audioInfo.outputType === 'folder' ? (
                <div className="bg-surface-elevated p-3 rounded-lg text-center">
                  <div className="flex items-center justify-center space-x-2 text-text-muted">
                    <Folder className="h-4 w-4" />
                    <span className="text-sm">Multiple audio files ready for download</span>
                  </div>
                </div>
              ) : (
                <div className="flex justify-center items-center h-16">
                  <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-status-success"></div>
                </div>
              )}
            </div>
          )}

          {/* Image Prompt Section */}
          {processImages && imagePromptInfo && (
            <div className="bg-surface-elevated rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="flex items-center justify-center w-10 h-10 bg-action-orange rounded-full">
                    <Edit className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h4 className="text-white font-medium">Image Prompts</h4>
                    <p className="text-text-dim text-sm">
                      {imagePromptInfo.title} • {imagePromptInfo.wordCount ? `${imagePromptInfo.wordCount.toLocaleString()} words` : 'Text file'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleDownloadImagePrompt}
                  className="flex items-center px-3 py-1 bg-action-orange text-white rounded-lg hover:bg-action-orange-hover text-sm"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Download
                </button>
              </div>
            </div>
          )}

          {/* Images Section */}
          {processImages && imagesInfo && (
            <div className="bg-surface-elevated rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center space-x-3">
                  <div className="flex items-center justify-center w-10 h-10 bg-action-purple rounded-full">
                    <Image className="h-5 w-5 text-white" />
                  </div>
                  <div>
                    <h4 className="text-white font-medium">Images</h4>
                    <p className="text-text-dim text-sm">
                      {imagesInfo.title} • {imagesInfo.imageCount} images
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleDownloadImages}
                  className="flex items-center px-3 py-1 bg-action-purple text-white rounded-lg hover:bg-action-purple-hover text-sm"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Download ZIP
                </button>
              </div>

              {/* Image Display */}
              {loadingImages ? (
                <div className="flex justify-center items-center h-32">
                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-status-pending"></div>
                </div>
              ) : generatedImages.length > 0 ? (
                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {generatedImages.map((url, index) => (
                    <div key={index} className="bg-surface-elevated rounded-lg p-3">
                      <div className="flex justify-between items-center mb-2">
                        <h5 className="text-sm font-medium text-white">
                          Image {index + 1}
                        </h5>
                      </div>
                      <img
                        src={url}
                        alt={`Generated Image ${index + 1}`}
                        className="w-full h-auto rounded-md max-h-64 object-contain"
                        onError={(e) => {
                          console.error(`Failed to load image ${index + 1}`);
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-surface-elevated p-3 rounded-lg text-center">
                  <div className="flex items-center justify-center space-x-2 text-text-muted">
                    <Folder className="h-4 w-4" />
                    <span className="text-sm">No images available for preview</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={handleDone}
            className="flex items-center px-6 py-3 bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors text-sm sm:text-base"
          >
            <CheckCircle2 className="h-5 w-5 mr-2" />
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default ComponentsCompletionScreen;




