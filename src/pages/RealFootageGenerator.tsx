import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Link } from 'react-router-dom';
import {
  Film, AlertCircle, CheckCircle2, X, Play, Download, RefreshCw,
} from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import DashboardLayout from '../components/DashboardLayout';
import StatusBanner from '../components/StatusBanner';
import TabManager from '../components/TabManager';
import { DocumentSelector } from '../components/FileUploadComponents';
import { TTV_STYLES, getStyleVideoUrl } from '../components/VideoModelSelector';
import { useTabSessionStorage } from '../hooks/useTabSessionStorage';
import { ensureTabExists, updateTabStatus, type TabInfo } from '../utils/tabManager';
import { sanitizeFileName } from '../utils/videoGeneratorUtils';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY,
);

const POLL_MS = 6000;
const CLIP_DURATIONS = [4, 5, 6, 8, 10];
const WORDS_PER_SECOND = 2.08;
const MAX_WORD_COUNT = 70000;
const MAX_FILE_SIZE_MB = 1;
const STYLE_PREVIEW_MODEL = 'grok';

interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  group_id?: string;
  file_path: string;
  word_count?: number;
  is_corrected: boolean;
  created_at: string;
  version?: number;
}

export interface RealFootageGeneratorRef {
  cleanup: () => Promise<void>;
}

interface Props {
  userId: string;
  initialTab?: number;
  isEnterpriseUser?: boolean;
  initialTabs?: TabInfo[];
  onTabChange?: (tab: number, groupId?: string) => void;
  onTabCreate?: (tab: number, groupId?: string) => void;
  onTabClose?: (tab: number, groupId?: string) => void;
}

const validateFileName = (name: string): string | null => {
  if (/[<>:"/\\|?*]/.test(name)) return 'File name contains invalid characters';
  if (name.length > 200) return 'File name is too long';
  return null;
};

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

function StyleVideoCard({
  name,
  description,
  videoUrl,
  isSelected,
  onClick,
}: {
  name: string;
  description: string;
  videoUrl: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  return (
    <div
      className={`relative bg-surface-elevated rounded-xl overflow-hidden cursor-pointer transition-all duration-200 ${
        isSelected ? 'ring-2 ring-accent-text' : 'hover:ring-2 hover:ring-border-subtle'
      }`}
      onClick={onClick}
      onMouseEnter={() => {
        videoRef.current?.play().then(() => setIsPlaying(true)).catch(() => {});
      }}
      onMouseLeave={() => {
        if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.currentTime = 0;
          setIsPlaying(false);
        }
      }}
    >
      <div className="aspect-video w-full relative">
        <video ref={videoRef} src={videoUrl} className="w-full h-full object-cover" preload="metadata" muted loop playsInline />
        <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 pointer-events-none ${isPlaying ? 'opacity-0' : 'bg-black/25'}`}>
          <div className="w-10 h-10 bg-black/60 rounded-full flex items-center justify-center">
            <Play className="h-5 w-5 text-white ml-0.5" />
          </div>
        </div>
      </div>
      <div className="p-4">
        <h3 className="text-base font-medium text-white mb-1">{name}</h3>
        <p className="text-sm text-text-dim">{description}</p>
      </div>
      {isSelected && (
        <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
          <CheckCircle2 className="h-5 w-5" />
        </div>
      )}
    </div>
  );
}

const RealFootageGenerator = forwardRef<RealFootageGeneratorRef, Props>(function RealFootageGenerator(
  {
    userId,
    initialTab = 1,
    isEnterpriseUser = false,
    initialTabs,
    onTabChange,
    onTabCreate,
    onTabClose,
  },
  ref,
) {
  const currentTab = initialTab;

  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useTabSessionStorage<string>('rf_selectedDoc', '', currentTab);
  const [uploadedDoc, setUploadedDoc] = useState<File | null>(null);
  const [uploadedDocId, setUploadedDocId] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [inputMode, setInputMode] = useTabSessionStorage<'document' | 'prompt'>('rf_inputMode', 'document', currentTab);
  const [singlePrompt, setSinglePrompt] = useTabSessionStorage<string>('rf_singlePrompt', '', currentTab);
  const [rfStyle, setRfStyle] = useTabSessionStorage<string>('rf_style', TTV_STYLES.find(s => s.name === 'Cinematic Film')?.style ?? TTV_STYLES[0].style, currentTab);
  const [clipDuration, setClipDuration] = useTabSessionStorage<number>('rf_clipDuration', 5, currentTab);
  const [totalAudioDuration, setTotalAudioDuration] = useTabSessionStorage<number>('rf_audioDuration', 60, currentTab);

  const [showAllStyles, setShowAllStyles] = useState(false);
  const [isCustomStyle, setIsCustomStyle] = useState(false);
  const [customStyleText, setCustomStyleText] = useState('');

  const [generationState, setGenerationState] = useState<'idle' | 'generating' | 'complete' | 'error'>('idle');
  const [currentPhase, setCurrentPhase] = useState<'prompts' | 'clips' | 'complete'>('prompts');
  const [phaseOneProgress, setPhaseOneProgress] = useState(0);
  const [phaseTwoProgress, setPhaseTwoProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [variant, setVariant] = useState(1);
  const [generationTitle, setGenerationTitle] = useState<string | null>(null);

  const [singleGenState, setSingleGenState] = useState<'idle' | 'generating' | 'complete' | 'error'>('idle');
  const [singleVideoUrl, setSingleVideoUrl] = useState<string | null>(null);
  const [singleTaskId, setSingleTaskId] = useState<string | null>(null);
  const [singleDoneLoading, setSingleDoneLoading] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const phaseRef = useRef<'prompts' | 'clips' | 'complete'>('prompts');

  const activeStyle = isCustomStyle ? customStyleText.trim() : rfStyle;
  const isGenerating = generationState === 'generating';
  const isComplete = generationState === 'complete';

  const getSelectedDocument = (): StoryDocument | undefined => {
    if (selectedDoc) return documents.find(d => d.id === selectedDoc);
    if (uploadedDocId) return documents.find(d => d.id === uploadedDocId);
    return undefined;
  };

  const selectedDocument = getSelectedDocument();
  const wordCount = selectedDocument?.word_count ?? 0;
  const estimatedClips = Math.max(1, Math.floor(totalAudioDuration / clipDuration));

  useImperativeHandle(ref, () => ({
    cleanup: async () => {
      stoppedRef.current = true;
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (!groupId) return;
      try {
        await supabase.from('RF_prompt_tasks').update({ stop_requested: true }).eq('user_id', userId).eq('group_id', groupId).eq('tab', currentTab);
        await supabase.from('RF_tasks').update({ stop_requested: true }).eq('user_id', userId).eq('group_id', groupId).eq('tab', currentTab);
      } catch { /* ignore */ }
    },
  }));

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('story_documents')
        .select('id, title, description, group_id, file_path, word_count, is_corrected, created_at, version')
        .eq('user_id', userId)
        .in('version', [1, 2])
        .order('created_at', { ascending: false })
        .limit(50);
      setDocuments(
        (data ?? []).map((d): StoryDocument => ({
          id: d.id,
          title: d.title,
          description: d.description,
          group_id: d.group_id,
          file_path: d.file_path,
          word_count: d.word_count,
          is_corrected: d.is_corrected ?? false,
          created_at: d.created_at ?? new Date().toISOString(),
          version: d.version,
        })),
      );
    };
    load();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [userId]);

  useEffect(() => {
    if (selectedDocument && wordCount > 0 && totalAudioDuration <= 0) {
      setTotalAudioDuration(Math.max(clipDuration, Math.round(wordCount / WORDS_PER_SECOND)));
    }
  }, [selectedDocument?.id, wordCount]);

  const startPolling = (gid: string, v: number) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    stoppedRef.current = false;

    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        if (phaseRef.current === 'prompts') {
          const { data: promptTasks } = await supabase
            .from('RF_prompt_tasks')
            .select('batch_number, total_batches, status, error, story_title')
            .eq('user_id', userId)
            .eq('group_id', gid)
            .eq('tab', currentTab)
            .eq('variant', v);

          if (!promptTasks?.length) return;
          const total = promptTasks[0].total_batches ?? promptTasks.length;
          const done = promptTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const err = promptTasks.find(t => t.status === 'error');
          if (err) {
            setError(err.error || 'Prompt generation failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          setPhaseOneProgress(total > 0 ? (done / total) * 100 : 0);
          setStatusMessage(`Generating search queries: ${done} / ${total}`);
          if (promptTasks[0].story_title) setGenerationTitle(promptTasks[0].story_title);

          if (promptTasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            phaseRef.current = 'clips';
            setCurrentPhase('clips');
            setStatusMessage('Queries ready — downloading stock clips…');
          } else {
            return;
          }
        }

        const { data: clipTasks } = await supabase
          .from('RF_tasks')
          .select('batch_number, total_batches, status, error')
          .eq('user_id', userId)
          .eq('group_id', gid)
          .eq('tab', currentTab)
          .eq('variant', v)
          .eq('single_rf', false);

        if (clipTasks?.length) {
          const total = clipTasks[0].total_batches ?? clipTasks.length;
          const done = clipTasks.filter(t => t.status === 'completed' || t.status === 'completed_final').length;
          const err = clipTasks.find(t => t.status === 'error');
          if (err) {
            setError(err.error || 'Clip download failed');
            setGenerationState('error');
            if (pollingRef.current) clearInterval(pollingRef.current);
            return;
          }
          setPhaseTwoProgress(total > 0 ? (done / total) * 100 : 0);
          setStatusMessage(`Downloading clips: ${done} / ${total}`);
          if (clipTasks.every(t => t.status === 'completed' || t.status === 'completed_final')) {
            setGenerationState('complete');
            setCurrentPhase('complete');
            setPhaseTwoProgress(100);
            setStatusMessage('All stock clips ready!');
            if (pollingRef.current) clearInterval(pollingRef.current);
            await updateTabStatus(userId, 'rf', currentTab, 'complete', gid);
          }
        }
      } catch { /* retry */ }
    };

    pollingRef.current = setInterval(poll, POLL_MS);
    poll();
  };

  useEffect(() => {
    const checkResume = async () => {
      const { data: singleTask } = await supabase
        .from('RF_tasks')
        .select('id, status, video_url')
        .eq('user_id', userId)
        .eq('tab', currentTab)
        .eq('single_rf', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (singleTask?.status === 'running') {
        setInputMode('prompt');
        setSingleGenState('generating');
        setSingleTaskId(singleTask.id);
        return;
      }
      if (singleTask?.status === 'completed_final' && singleTask.video_url) {
        const { data: urlData } = await supabase.storage.from('stories').createSignedUrl(singleTask.video_url, 3600);
        if (urlData?.signedUrl) {
          setInputMode('prompt');
          setSingleGenState('complete');
          setSingleTaskId(singleTask.id);
          setSingleVideoUrl(urlData.signedUrl);
          await updateTabStatus(userId, 'rf', currentTab, 'complete').catch(() => {});
        }
        return;
      }

      const { data: tab } = await supabase
        .from('tabs')
        .select('group_id, status, title')
        .eq('user_id', userId)
        .eq('page', 'rf')
        .eq('tab_number', currentTab)
        .in('status', ['generating', 'complete'])
        .maybeSingle();

      if (!tab?.group_id) return;
      setGenerationTitle(tab.title ?? null);

      if (tab.status === 'complete') {
        setGroupId(tab.group_id);
        setCurrentPhase('complete');
        setGenerationState('complete');
        setPhaseTwoProgress(100);
        setPhaseOneProgress(100);
        return;
      }

      const { data: promptTasks } = await supabase
        .from('RF_prompt_tasks')
        .select('variant, status')
        .eq('user_id', userId)
        .eq('group_id', tab.group_id)
        .eq('tab', currentTab);

      if (!promptTasks?.length) return;
      const v = promptTasks[0].variant ?? 1;
      const promptsDone = promptTasks.every(t => t.status === 'completed' || t.status === 'completed_final');
      setGroupId(tab.group_id);
      setVariant(v);
      phaseRef.current = promptsDone ? 'clips' : 'prompts';
      setCurrentPhase(promptsDone ? 'clips' : 'prompts');
      setGenerationState('generating');
      setStatusMessage('Resuming generation…');
      startPolling(tab.group_id, v);
    };
    checkResume().catch(() => {});
  }, [userId, currentTab]);

  useEffect(() => {
    if (singleGenState !== 'generating' || !singleTaskId) return;
    const interval = setInterval(async () => {
      try {
        const { data: task } = await supabase
          .from('RF_tasks')
          .select('id, status, video_url, error')
          .eq('id', singleTaskId)
          .maybeSingle();
        if (!task) return;
        if (task.status === 'completed_final' && task.video_url) {
          const { data: urlData } = await supabase.storage.from('stories').createSignedUrl(task.video_url, 3600);
          if (urlData) setSingleVideoUrl(urlData.signedUrl);
          setSingleGenState('complete');
          await updateTabStatus(userId, 'rf', currentTab, 'complete').catch(() => {});
        } else if (task.status === 'error') {
          setError(task.error || 'Stock clip search failed');
          setSingleGenState('error');
        }
      } catch { /* retry */ }
    }, 10_000);
    return () => clearInterval(interval);
  }, [singleGenState, singleTaskId, userId, currentTab]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedDoc('');
    setUploadError(null);
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
      setUploadError('Please upload a .txt file');
      return;
    }
    const nameErr = validateFileName(file.name);
    if (nameErr) { setUploadError(nameErr); return; }
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setUploadError(`Max file size is ${MAX_FILE_SIZE_MB} MB`);
      return;
    }
    setUploadingFile(true);
    try {
      const content = await file.text();
      const wc = content.trim().split(/\s+/).filter(w => w.length > 0).length;
      if (wc > MAX_WORD_COUNT) throw new Error(`Exceeds ${MAX_WORD_COUNT} word limit (${wc} words)`);
      const gid = uuidv4();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const fname = `${file.name.replace(/\s+/g, '-')}_${ts}.txt`;
      const fpath = `documents/${userId}/${gid}/${fname}`;
      const { error: upErr } = await supabase.storage.from('stories').upload(fpath, file, { contentType: 'text/plain', upsert: true });
      if (upErr) throw upErr;
      const { data: doc, error: insErr } = await supabase
        .from('story_documents')
        .insert({
          id: uuidv4(), user_id: userId, file_path: fpath,
          title: file.name.replace(/\.txt$/, ''),
          description: 'Uploaded document for Real Footage generation',
          word_count: wc, version: 1, is_corrected: false,
          is_prompted: false, group_id: gid, variant: 1, file_size: file.size,
        })
        .select()
        .single();
      if (insErr) { await supabase.storage.from('stories').remove([fpath]); throw insErr; }
      setUploadedDoc(file);
      setUploadedDocId(doc!.id);
      setDocuments(prev => [doc as StoryDocument, ...prev]);
      setTotalAudioDuration(Math.max(clipDuration, Math.round(wc / WORDS_PER_SECOND)));
    } catch (err) {
      setUploadError((err as Error).message || 'Upload failed');
    } finally {
      setUploadingFile(false);
    }
  };

  const handleGenerate = async () => {
    const doc = getSelectedDocument();
    if (!doc) {
      setError('Select a story document');
      return;
    }
    if (!activeStyle) {
      setError('Select a visual style');
      return;
    }
    if (totalAudioDuration <= 0) {
      setError('Set story runtime (seconds)');
      return;
    }

    setError(null);
    setGenerationState('generating');
    setCurrentPhase('prompts');
    phaseRef.current = 'prompts';
    setPhaseOneProgress(0);
    setPhaseTwoProgress(0);
    setStatusMessage('Starting Real Footage…');

    try {
      const gid = doc.group_id || uuidv4();
      setGroupId(gid);
      let v = 1;
      const { data: existing } = await supabase
        .from('story_documents')
        .select('variant')
        .eq('group_id', gid)
        .eq('user_id', userId)
        .in('version', [12, 13, 14, 15]);
      if (existing?.length) v = Math.max(...existing.map(d => d.variant || 0)) + 1;
      setVariant(v);
      setGenerationTitle(doc.title);

      await ensureTabExists(userId, 'rf');
      await updateTabStatus(userId, 'rf', currentTab, 'generating', gid, doc.title);

      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/setup-RF-prompts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          apikey: import.meta.env.SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          user_id: userId,
          group_id: gid,
          file_path: doc.file_path,
          story_title: doc.title,
          description: doc.description || doc.title,
          style: activeStyle,
          video_model: 'stock',
          video_duration: clipDuration,
          totalAudioDuration,
          useCharacterDescriptions: false,
          model: 'sonnet',
          language: 'english',
          tab: currentTab,
          variant: v,
          userTokenBalance: 1_000_000,
          audio_clip: false,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setStatusMessage(`Queued ~${body.total_videos ?? estimatedClips} clips`);
      startPolling(gid, v);
    } catch (e) {
      setError((e as Error).message);
      setGenerationState('error');
    }
  };

  const handleGenerateSingle = async () => {
    if (!singlePrompt.trim()) {
      setError('Please enter a search prompt');
      return;
    }
    if (!activeStyle) {
      setError('Select a visual style');
      return;
    }
    setError(null);
    setSingleGenState('generating');
    setSingleVideoUrl(null);
    setSingleTaskId(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const gid = uuidv4();
      await updateTabStatus(userId, 'rf', currentTab, 'generating', gid, 'Single Stock Clip');
      const res = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/single-RF`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          group_id: gid,
          story_title: 'single_rf',
          prompt: singlePrompt.trim(),
          style_prompt: activeStyle,
          video_duration: clipDuration,
          tab: currentTab,
        }),
      });
      if (!res.ok && res.status !== 202) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSingleTaskId(data.task_id);
    } catch (err) {
      const msg = (err as Error).message || 'Failed to start clip search';
      setError(
        msg === 'Failed to fetch'
          ? 'Could not reach the single-RF edge function. Ensure it is deployed on your Supabase project (functions/v1/single-RF).'
          : msg,
      );
      setSingleGenState('error');
    }
  };

  const handleDoneSingle = async () => {
    setSingleGenState('idle');
    await updateTabStatus(userId, 'rf', currentTab, 'idle').catch(() => {});
    setSingleDoneLoading(true);
    try {
      if (singleTaskId) {
        const { data: task } = await supabase.from('RF_tasks').select('video_url').eq('id', singleTaskId).maybeSingle();
        if (task?.video_url) {
          const folder = task.video_url.replace(/\/[^/]+$/, '');
          const { data: files } = await supabase.storage.from('stories').list(folder);
          if (files?.length) {
            await supabase.storage.from('stories').remove(files.map(f => `${folder}/${f.name}`));
          }
        }
        await supabase.from('RF_tasks').delete().eq('id', singleTaskId);
      }
    } catch { /* ignore */ }
    setSingleTaskId(null);
    setSingleVideoUrl(null);
    setSingleDoneLoading(false);
  };

  const handleReset = () => {
    stoppedRef.current = true;
    if (pollingRef.current) clearInterval(pollingRef.current);
    setGenerationState('idle');
    phaseRef.current = 'prompts';
    setCurrentPhase('prompts');
    setPhaseOneProgress(0);
    setPhaseTwoProgress(0);
    setStatusMessage('');
    setGroupId(null);
    setGenerationTitle(null);
    updateTabStatus(userId, 'rf', currentTab, 'idle').catch(() => {});
  };

  const canGenerateDocument =
    !!selectedDocument && !!activeStyle && totalAudioDuration > 0 && !isGenerating && !isComplete;

  const configCollapsed =
    isGenerating || isComplete || singleGenState === 'generating' || singleGenState === 'complete';

  return (
    <DashboardLayout>
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" style={{ zoom: 1.1 }}>
        <div className="pointer-events-none absolute inset-0 -top-20 overflow-hidden" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120%] h-[500px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(220,38,38,0.14)_0%,transparent_70%)]" />
        </div>

        <div className="relative mb-8 dash-animate-in">
          <h1 className="text-4xl font-display font-semibold text-white tracking-tight">Real Footage Generator</h1>
          <p className="text-text-secondary mt-2">
            Turn your story into stock video clips from Coverr and Pexels. Search terms are generated with Claude Sonnet 4.6.
          </p>
          <Link to="/home" className="text-sm text-amber-400/80 hover:text-amber-300 mt-2 inline-block">
            ← Back to Home
          </Link>
        </div>

        <div className="mt-5 p-5 rounded-2xl bg-surface-card backdrop-blur-sm border border-border-card dash-animate-in mb-6">
          <h3 className="text-xl font-semibold mb-2 text-accent">What to Expect</h3>
          <p className="text-[15px] text-white/80 leading-relaxed">
            Real Footage takes your story (or a single search prompt) and finds matching stock clips from Coverr and Pexels.
            Claude generates search keywords per scene, then the system downloads and saves clips to your Documents folder as RF Outputs.
          </p>
          <div className="mt-4 pt-4 border-t border-white/10">
            <p className="text-sm text-text-muted leading-relaxed">
              Choose <strong className="text-white/90">Existing Document</strong> for a full story run, or <strong className="text-white/90">Individual Prompt</strong> for one stock clip.
              Set visual style and clip timing, then generate. Clips appear under Documents as RF Outputs.
            </p>
          </div>
        </div>

        {isEnterpriseUser && (
          <TabManager
            userId={userId}
            isEnterpriseUser={isEnterpriseUser}
            initialTabs={initialTabs}
            currentTab={currentTab}
            page="rf"
            onTabChange={(tab) => onTabChange?.(tab, groupId ?? '')}
            onTabCreate={(tab) => onTabCreate?.(tab, groupId ?? '')}
            onTabClose={(tab) => onTabClose?.(tab, groupId ?? '')}
          />
        )}

        {error && (
          <div className="p-5 rounded-2xl bg-[--color-status-error-bg] border border-[--color-status-error-border] mb-6 dash-animate-in">
            <div className="flex items-center space-x-3">
              <AlertCircle className="h-5 w-5 text-status-error shrink-0" />
              <p className="text-sm text-status-error/80 flex-1">{error}</p>
              <button type="button" onClick={() => setError(null)} className="text-status-error shrink-0">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        )}

        {isGenerating && (
          <StatusBanner
            variant="info"
            title={<>Generation in Progress{generationTitle ? ` — ${generationTitle}` : ''}</>}
            subtitle={statusMessage}
          />
        )}

        {isComplete && (
          <StatusBanner
            variant="success"
            title={<>Stock Clips Ready{generationTitle ? ` — ${generationTitle}` : ''}</>}
            subtitle="Clips are saved in Documents under RF Outputs. You can download the folder from Your Documents."
          />
        )}

        {singleGenState === 'generating' && (
          <StatusBanner variant="info" title="Finding stock clip…" subtitle="Searching Coverr and Pexels. This usually takes under a minute." />
        )}

        {singleGenState === 'complete' && singleVideoUrl && (
          <StatusBanner variant="success" title="Clip ready!" subtitle="Preview below or download, then press Done to search another clip." />
        )}

        <div className="dash-collapse-grid" data-collapsed={configCollapsed ? 'true' : 'false'}>
          <div key={inputMode} className="space-y-6 dash-stagger">

            <div className="dash-animate-in">
              <h2 className="text-xl font-semibold text-white mb-4">Mode</h2>
              <div className="grid grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setInputMode('document')}
                  disabled={isGenerating || isComplete || singleGenState !== 'idle'}
                  className={`p-4 rounded-xl border-2 transition-all text-left ${
                    inputMode === 'document' ? 'border-red-800/70 bg-red-900/30' : 'border-border-card bg-surface-card hover:border-white/20'
                  } ${(isGenerating || isComplete || singleGenState !== 'idle') ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="font-medium text-white text-sm sm:text-base">Existing Document</div>
                  <div className="text-xs sm:text-sm text-text-muted mt-1">Generate clips from a story document</div>
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('prompt')}
                  disabled={isGenerating || isComplete || singleGenState !== 'idle'}
                  className={`p-4 rounded-xl border-2 transition-all text-left ${
                    inputMode === 'prompt' ? 'border-red-800/70 bg-red-900/30' : 'border-border-card bg-surface-card hover:border-white/20'
                  } ${(isGenerating || isComplete || singleGenState !== 'idle') ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="font-medium text-white text-sm sm:text-base">Individual Prompt</div>
                  <div className="text-xs sm:text-sm text-text-muted mt-1">Search one stock clip from a prompt</div>
                </button>
              </div>
            </div>

            {inputMode === 'document' && (
              <div>
                <h2 className="text-xl font-semibold text-white mb-2">Select or Upload Story Document</h2>
                <p className="text-text-secondary mb-4">
                  Select one of your Story Documents or upload a .txt file to generate stock clips.
                </p>
                <DocumentSelector
                  documents={documents}
                  selectedDoc={selectedDoc || uploadedDocId || ''}
                  onDocChange={(id) => { setSelectedDoc(id); setUploadedDoc(null); setUploadedDocId(null); }}
                  uploadedDoc={uploadedDoc}
                  onUploadedDocChange={(f) => { setUploadedDoc(f); if (!f) setUploadedDocId(null); }}
                  onFileUpload={handleFileUpload}
                  uploadingFile={uploadingFile}
                  disabled={isGenerating}
                  error={uploadError}
                />
                {selectedDocument && (
                  <div className="mt-2 px-1 flex flex-wrap items-center gap-3 text-xs text-text-dim">
                    <span>{selectedDocument.word_count?.toLocaleString() ?? '?'} words</span>
                    {wordCount > 0 && (
                      <>
                        <span>·</span>
                        <span>~{formatDuration(wordCount / WORDS_PER_SECOND)} estimated runtime</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {inputMode === 'prompt' && (
              <div className="bg-surface-card rounded-xl p-6">
                <h2 className="text-xl font-semibold text-white mb-4">Individual Stock Clip</h2>
                <p className="text-text-muted mb-6">
                  Describe the scene you need. We search Coverr and Pexels and save one matching clip.
                </p>
                <label className="block text-sm font-medium text-white mb-3">Search prompt</label>
                <textarea
                  value={singlePrompt}
                  onChange={e => setSinglePrompt(e.target.value)}
                  placeholder="e.g. underwater sunlight rays, coral reef, cinematic documentary…"
                  rows={8}
                  disabled={singleGenState !== 'idle'}
                  className="w-full bg-surface-elevated text-white rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-accent-text resize-none"
                />
                <p className="text-xs text-text-dim mt-2">{singlePrompt.length} characters</p>
              </div>
            )}

            <div className="p-4 rounded-xl bg-surface-card border border-border-card">
              <p className="text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-2">Source</p>
              <p className="text-white font-medium">Stock footage — Coverr + Pexels</p>
              <p className="text-sm text-text-muted mt-1">No AI video generation; clips are real stock video matched to your prompts.</p>
            </div>

            <div>
              <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Visual Style</label>
              <div className="grid md:grid-cols-2 gap-6">
                {TTV_STYLES.slice(0, showAllStyles ? TTV_STYLES.length : 4).map(s => (
                  <StyleVideoCard
                    key={s.name}
                    name={s.name}
                    description={s.description}
                    videoUrl={getStyleVideoUrl(STYLE_PREVIEW_MODEL, s.videoFileName)}
                    isSelected={!isCustomStyle && rfStyle === s.style}
                    onClick={() => { setRfStyle(s.style); setIsCustomStyle(false); }}
                  />
                ))}
              </div>
              {TTV_STYLES.length > 4 && (
                <div className="flex justify-center mt-4">
                  <button
                    type="button"
                    onClick={() => setShowAllStyles(p => !p)}
                    className="px-4 py-2 bg-white/10 text-white rounded-xl hover:bg-white/15 transition-colors"
                  >
                    {showAllStyles ? 'Show Less' : `Show More +${TTV_STYLES.length - 4}`}
                  </button>
                </div>
              )}
              <div className="mt-6 rounded-xl overflow-hidden border border-border-card">
                <div className="p-4">
                  <h3 className="text-lg font-medium text-white mb-2">Custom Style</h3>
                  <textarea
                    value={isCustomStyle ? customStyleText : ''}
                    onChange={e => { setCustomStyleText(e.target.value.slice(0, 1200)); setIsCustomStyle(true); }}
                    onClick={() => setIsCustomStyle(true)}
                    placeholder="Describe your visual style for stock search context…"
                    rows={4}
                    maxLength={1200}
                    className="w-full bg-surface-input border border-white/[0.13] rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-red-900/60"
                  />
                </div>
              </div>
            </div>

            {inputMode === 'document' && (
              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Generation Settings</label>
                <div className="space-y-4 p-5 rounded-2xl bg-surface-card border border-border-card">
                  <div>
                    <label className="block text-sm text-text-dim mb-2">Clip length (seconds)</label>
                    <div className="flex flex-wrap gap-2">
                      {CLIP_DURATIONS.map(d => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setClipDuration(d)}
                          disabled={isGenerating}
                          className={`px-4 py-2 rounded-xl border text-sm font-medium transition-colors ${
                            clipDuration === d
                              ? 'border-red-800/70 bg-red-900/30 text-white'
                              : 'border-border bg-surface-elevated text-text-muted hover:border-border-subtle'
                          }`}
                        >
                          {d}s
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm text-text-dim mb-2">Story runtime (seconds)</label>
                    <input
                      type="number"
                      min={clipDuration}
                      value={totalAudioDuration}
                      onChange={e => setTotalAudioDuration(Math.max(clipDuration, Number(e.target.value)))}
                      disabled={isGenerating}
                      className="w-full max-w-xs bg-surface-elevated border border-border-card rounded-xl px-3 py-2 text-white"
                    />
                    <p className="text-xs text-text-dim mt-2">~{estimatedClips} clips at {clipDuration}s each</p>
                  </div>
                </div>
              </div>
            )}

            {inputMode === 'prompt' && (
              <div>
                <label className="block text-[10px] font-mono tracking-[0.15em] text-text-label uppercase mb-4">Clip Settings</label>
                <div className="p-5 rounded-2xl bg-surface-card border border-border-card">
                  <label className="block text-sm text-text-dim mb-2">Target clip length (seconds)</label>
                  <div className="flex flex-wrap gap-2">
                    {CLIP_DURATIONS.map(d => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setClipDuration(d)}
                        disabled={singleGenState !== 'idle'}
                        className={`px-4 py-2 rounded-xl border text-sm font-medium ${
                          clipDuration === d ? 'border-red-800/70 bg-red-900/30 text-white' : 'border-border bg-surface-elevated text-text-muted'
                        }`}
                      >
                        {d}s
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>

        {inputMode === 'document' && isGenerating && (
          <div className="mb-6 bg-surface-elevated/50 rounded-xl p-6 space-y-4 mt-4">
            <div className="flex items-center space-x-3 text-text-muted">
              <RefreshCw className="h-5 w-5 text-status-error animate-pulse" />
              <span>{statusMessage}</span>
            </div>
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1">
                <span>Phase 1 — Search queries</span>
                <span>{currentPhase !== 'prompts' ? 'Complete ✓' : `${Math.round(phaseOneProgress)}%`}</span>
              </div>
              <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                <div className="h-full bg-status-info-muted rounded-full transition-all" style={{ width: `${currentPhase !== 'prompts' ? 100 : phaseOneProgress}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1">
                <span>Phase 2 — Stock clips</span>
                <span>{currentPhase === 'complete' ? 'Complete ✓' : currentPhase === 'clips' ? `${Math.round(phaseTwoProgress)}%` : 'Waiting…'}</span>
              </div>
              <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
                <div className="h-full bg-action-purple rounded-full transition-all" style={{ width: `${currentPhase === 'complete' ? 100 : currentPhase === 'clips' ? phaseTwoProgress : 0}%` }} />
              </div>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={handleReset} className="text-sm text-text-dim hover:text-white">
                Stop / reset
              </button>
            </div>
          </div>
        )}

        {inputMode === 'document' && !isGenerating && !isComplete && (
          <div className="flex flex-col items-center gap-2 pb-8 mt-4">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canGenerateDocument}
              className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-base font-semibold transition-all ${
                canGenerateDocument
                  ? 'bg-accent hover:bg-accent-hover text-white shadow-lg'
                  : 'bg-surface-elevated text-text-dim cursor-not-allowed'
              }`}
            >
              <Film className="w-5 h-5" />
              Generate Real Footage
            </button>
            {!canGenerateDocument && (
              <p className="text-xs text-text-dim text-center">Select a document, style, and runtime to enable generation.</p>
            )}
          </div>
        )}

        {inputMode === 'document' && (isComplete || generationState === 'error') && (
          <div className="flex justify-center gap-3 pb-8 mt-4">
            <button type="button" onClick={handleReset} className="px-6 py-3 border border-border rounded-xl text-text-secondary hover:bg-surface-card">
              Start over
            </button>
            <Link to="/documents" className="px-6 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover">
              View in Documents
            </Link>
          </div>
        )}

        {inputMode === 'prompt' && singleGenState !== 'generating' && singleGenState !== 'complete' && (
          <div className="bg-surface-card rounded-xl p-6 mt-6">
            <button
              type="button"
              onClick={handleGenerateSingle}
              disabled={!singlePrompt.trim() || !activeStyle}
              className="w-full flex justify-center items-center gap-2 px-4 py-3 bg-accent text-white rounded-xl hover:bg-accent-hover disabled:opacity-50"
            >
              <Film className="w-5 h-5" />
              Search stock clip
            </button>
          </div>
        )}

        {inputMode === 'prompt' && singleGenState === 'generating' && (
          <div className="flex justify-center py-12 mt-6">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent-text" />
          </div>
        )}

        {inputMode === 'prompt' && singleGenState === 'complete' && singleVideoUrl && (
          <div className="space-y-6 mt-6">
            <div className="bg-surface-card rounded-xl p-4 border border-status-success">
              <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
                <h3 className="text-lg font-medium text-status-success">Stock clip</h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await fetch(singleVideoUrl);
                        const blob = await res.blob();
                        const objUrl = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = objUrl;
                        a.download = `${sanitizeFileName('stock-clip')}.mp4`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(objUrl);
                      } catch {
                        window.open(singleVideoUrl, '_blank');
                      }
                    }}
                    className="flex items-center px-3 py-1 bg-action-success text-white rounded-xl text-sm"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </button>
                  <button
                    type="button"
                    onClick={handleDoneSingle}
                    disabled={singleDoneLoading}
                    className="flex items-center px-3 py-1 bg-action-success text-white rounded-xl text-sm disabled:opacity-60"
                  >
                    {singleDoneLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                    Done
                  </button>
                </div>
              </div>
              <video src={singleVideoUrl} controls className="w-full rounded-xl" preload="metadata" />
            </div>
          </div>
        )}

        {groupId && inputMode === 'document' && (
          <p className="text-xs text-text-dim mt-4 pb-8">
            Group ID: {groupId}
            {variant > 1 ? ` · variant ${variant}` : ''}
          </p>
        )}
      </div>
    </DashboardLayout>
  );
});

export default RealFootageGenerator;
