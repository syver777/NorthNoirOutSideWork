import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Link } from 'react-router-dom';
import { Film, AlertCircle, CheckCircle2 } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import DashboardLayout from '../components/DashboardLayout';
import { ensureTabExists, updateTabStatus } from '../utils/tabManager';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

const POLL_MS = 6000;
const CLIP_DURATIONS = [4, 5, 6, 8, 10];

interface StoryDocument {
  id: string;
  title: string;
  description?: string;
  group_id?: string;
  file_path: string;
  word_count?: number;
}

export interface RealFootageGeneratorRef {
  cleanup: () => Promise<void>;
}

interface Props {
  userId: string;
  initialTab?: number;
  isEnterpriseUser?: boolean;
  initialTabs?: unknown;
  onTabChange?: (tab: number) => void;
  onTabCreate?: (tab: number) => void;
  onTabClose?: (tab: number) => void;
}

const RealFootageGenerator = forwardRef<RealFootageGeneratorRef, Props>(function RealFootageGenerator(
  { userId, initialTab = 1 },
  ref,
) {
  const currentTab = initialTab;
  const [documents, setDocuments] = useState<StoryDocument[]>([]);
  const [selectedDocId, setSelectedDocId] = useState('');
  const [clipDuration, setClipDuration] = useState(5);
  const [style, setStyle] = useState('cinematic documentary, natural lighting');
  const [totalAudioDuration, setTotalAudioDuration] = useState(60);
  const [generationState, setGenerationState] = useState<'idle' | 'generating' | 'complete' | 'error'>('idle');
  const [currentPhase, setCurrentPhase] = useState<'prompts' | 'clips' | 'complete'>('prompts');
  const [phaseOneProgress, setPhaseOneProgress] = useState(0);
  const [phaseTwoProgress, setPhaseTwoProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [variant, setVariant] = useState(1);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);
  const phaseRef = useRef<'prompts' | 'clips' | 'complete'>('prompts');

  useImperativeHandle(ref, () => ({
    cleanup: async () => {
      stoppedRef.current = true;
      if (pollingRef.current) clearInterval(pollingRef.current);
    },
  }));

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('story_documents')
        .select('id, title, description, group_id, file_path, word_count')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      setDocuments((data as StoryDocument[]) ?? []);
    };
    load();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [userId]);

  const selectedDoc = documents.find(d => d.id === selectedDocId);
  const estimatedClips = Math.max(1, Math.floor(totalAudioDuration / clipDuration));

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
          .eq('variant', v);

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
      } catch {
        /* retry next tick */
      }
    };

    pollingRef.current = setInterval(poll, POLL_MS);
    poll();
  };

  const handleGenerate = async () => {
    if (!selectedDoc) {
      setError('Select a story document');
      return;
    }
    setError(null);
    setGenerationState('generating');
    setCurrentPhase('prompts');
    setPhaseOneProgress(0);
    setPhaseTwoProgress(0);
    setStatusMessage('Starting Real Footage…');

    try {
      const gid = selectedDoc.group_id || uuidv4();
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

      await ensureTabExists(userId, 'rf');
      await updateTabStatus(userId, 'rf', currentTab, 'generating', gid, selectedDoc.title);

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
          file_path: selectedDoc.file_path,
          story_title: selectedDoc.title,
          description: selectedDoc.description || selectedDoc.title,
          style,
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
    updateTabStatus(userId, 'rf', currentTab, 'idle').catch(() => {});
  };

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-display font-semibold text-white flex items-center gap-3">
            <Film className="w-8 h-8 text-red-500" />
            Real Footage Generator
          </h1>
          <p className="text-text-secondary mt-2">
            Turn your story into stock video clips from Coverr and Pexels. Search terms are generated with Claude Sonnet 4.6.
          </p>
          <Link to="/home" className="text-sm text-amber-400/80 hover:text-amber-300 mt-2 inline-block">
            ← Back to Home
          </Link>
        </div>

        {error && (
          <div className="mb-4 p-4 rounded-lg bg-red-900/30 border border-red-500/50 flex gap-2 text-red-200">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {generationState === 'complete' && (
          <div className="mb-4 p-4 rounded-lg bg-green-900/30 border border-green-500/50 flex gap-2 text-green-200">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <span>Generation complete. Clips are in Documents storage under the RF Outputs folder.</span>
          </div>
        )}

        <div className="space-y-6 bg-surface-secondary/50 border border-border rounded-xl p-6">
          <div>
            <label className="block text-sm text-text-secondary mb-2">Story document</label>
            <select
              value={selectedDocId}
              onChange={e => setSelectedDocId(e.target.value)}
              className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-white"
              disabled={generationState === 'generating'}
            >
              <option value="">Select a document…</option>
              {documents.map(d => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-2">Visual style (for search context)</label>
            <input
              type="text"
              value={style}
              onChange={e => setStyle(e.target.value)}
              className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-white"
              disabled={generationState === 'generating'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-text-secondary mb-2">Clip length (seconds)</label>
              <select
                value={clipDuration}
                onChange={e => setClipDuration(Number(e.target.value))}
                className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-white"
                disabled={generationState === 'generating'}
              >
                {CLIP_DURATIONS.map(d => (
                  <option key={d} value={d}>{d}s</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-2">Story runtime (seconds)</label>
              <input
                type="number"
                min={clipDuration}
                value={totalAudioDuration}
                onChange={e => setTotalAudioDuration(Math.max(clipDuration, Number(e.target.value)))}
                className="w-full bg-surface-primary border border-border rounded-lg px-3 py-2 text-white"
                disabled={generationState === 'generating'}
              />
              <p className="text-xs text-text-dim mt-1">~{estimatedClips} clips at {clipDuration}s each</p>
            </div>
          </div>

          {generationState === 'generating' && (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                {statusMessage}
                <span className="text-text-dim"> · {currentPhase === 'clips' ? 'Phase 2' : 'Phase 1'}</span>
              </p>
              <div>
                <div className="flex justify-between text-xs text-text-dim mb-1">
                  <span>Phase 1 — Search queries</span>
                  <span>{Math.round(phaseOneProgress)}%</span>
                </div>
                <div className="h-2 bg-surface-primary rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 transition-all" style={{ width: `${phaseOneProgress}%` }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs text-text-dim mb-1">
                  <span>Phase 2 — Stock clips</span>
                  <span>{Math.round(phaseTwoProgress)}%</span>
                </div>
                <div className="h-2 bg-surface-primary rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 transition-all" style={{ width: `${phaseTwoProgress}%` }} />
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generationState === 'generating' || !selectedDocId}
              className="px-6 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium rounded-lg"
            >
              {generationState === 'generating' ? 'Generating…' : 'Generate Real Footage'}
            </button>
            {(generationState === 'complete' || generationState === 'error') && (
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2.5 border border-border text-text-secondary rounded-lg hover:bg-surface-primary"
              >
                Start over
              </button>
            )}
          </div>
        </div>

        {groupId && (
          <p className="text-xs text-text-dim mt-4">
            Group ID: {groupId}
            {variant > 1 ? ` · variant ${variant}` : ''}
          </p>
        )}
      </div>
    </DashboardLayout>
  );
});

export default RealFootageGenerator;
