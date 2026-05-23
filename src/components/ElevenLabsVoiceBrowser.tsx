import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Search,
  Play,
  Pause,
  Loader2,
  ChevronDown,
  Check,
  X,
  Sparkles,
  Info,
} from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import { createClient } from '@supabase/supabase-js';
import {
  ELEVENLABS_MODELS,
  DEFAULT_ELEVENLABS_MODEL_ID,
  pickModelForVoice,
  isModelCompatibleWithVoice,
  getElevenLabsModel,
} from '../data/elevenlabsModels';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY,
);

// ---------------------------------------------------------------------------
// Types matching the ElevenLabs upstream payload (only the fields we use).
// ---------------------------------------------------------------------------

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string; // 'premade' | 'cloned' | 'professional' | 'famous' | 'high_quality' ...
  preview_url?: string;
  description?: string;
  labels?: Record<string, string>;
  language?: string;
  accent?: string;
  age?: string;
  gender?: string;
  use_case?: string;
  descriptive?: string;
  free_users_allowed?: boolean;
  /** Restricts the voice to specific base models (if non-empty). */
  high_quality_base_model_ids?: string[];
  verified_languages?: Array<{ language: string; locale?: string; accent?: string }>;
  image_url?: string;
}

export interface SelectedElevenLabsVoice {
  voice_id: string;
  name: string;
  model_id: string;
  preview_url?: string;
  high_quality_base_model_ids?: string[];
  language?: string;
}

interface ElevenLabsVoiceBrowserProps {
  onBack?: () => void;
  onSelectVoice: (voice: SelectedElevenLabsVoice) => void;
  currentSelectedVoiceId?: string;
  initialModelId?: string;
  /** Called whenever the model dropdown changes (independent of voice selection). */
  onModelChange?: (modelId: string) => void;
  /** When true, renders inline without outer card chrome / back button. */
  embedded?: boolean;
}

// ---------------------------------------------------------------------------
// Filter option lists. These mirror the chips on elevenlabs.io / Voice Library.
// ---------------------------------------------------------------------------

type ChipOption = { value: string; label: string };

// ElevenLabs `/v1/shared-voices` accepts: professional | high_quality | famous.
// We omit `famous` because it maps to the Iconic Voice Marketplace, which
// requires per-voice licensing and is not usable via the public API.
const CATEGORY_OPTIONS: ChipOption[] = [
  { value: 'professional', label: 'Professional' },
  { value: 'high_quality', label: 'High quality' },
];

const GENDER_OPTIONS: ChipOption[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'neutral', label: 'Neutral' },
];

const AGE_OPTIONS: ChipOption[] = [
  { value: 'young', label: 'Young' },
  { value: 'middle_aged', label: 'Middle aged' },
  { value: 'old', label: 'Old' },
];

const ACCENT_OPTIONS: ChipOption[] = [
  { value: 'american', label: 'American' },
  { value: 'british', label: 'British' },
  { value: 'australian', label: 'Australian' },
  { value: 'irish', label: 'Irish' },
  { value: 'canadian', label: 'Canadian' },
  { value: 'indian', label: 'Indian' },
  { value: 'african', label: 'African' },
  { value: 'european', label: 'European' },
];

const LANGUAGE_OPTIONS: ChipOption[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'pl', label: 'Polish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ar', label: 'Arabic' },
  { value: 'ru', label: 'Russian' },
  { value: 'tr', label: 'Turkish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'no', label: 'Norwegian' },
  { value: 'da', label: 'Danish' },
];

// Values must match ElevenLabs `use_case` strings. Some are combined
// (e.g. characters & animation share one tag).
const USE_CASE_OPTIONS: ChipOption[] = [
  { value: 'narrative_story', label: 'Narration & story' },
  { value: 'conversational', label: 'Conversational' },
  { value: 'characters_animation', label: 'Characters & animation' },
  { value: 'social_media', label: 'Social media' },
  { value: 'entertainment_tv', label: 'Entertainment & TV' },
  { value: 'advertisement', label: 'Advertisement' },
  { value: 'informative_educational', label: 'Informative & educational' },
];

// ElevenLabs `/v1/shared-voices` accepts: trending | created_date | usage_character_count_1y | cloned_by_count
const SORT_OPTIONS = [
  { value: 'trending', label: 'Trending' },
  { value: 'created_date', label: 'Latest' },
  { value: 'usage_character_count_1y', label: 'Most used' },
  { value: 'cloned_by_count', label: 'Most cloned' },
];

const PAGE_SIZE = 30;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ElevenLabsVoiceBrowser({
  onBack,
  onSelectVoice,
  currentSelectedVoiceId,
  initialModelId,
  onModelChange,
  embedded = false,
}: ElevenLabsVoiceBrowserProps) {
  // Search + filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [gender, setGender] = useState<string | null>(null);
  const [age, setAge] = useState<string | null>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [useCase, setUseCase] = useState<string | null>(null);
  const [sort, setSort] = useState<string>('trending');
  const [modelId, setModelId] = useState<string>(initialModelId ?? DEFAULT_ELEVENLABS_MODEL_ID);

  // Voices + paging
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audio preview
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Build query string from current filter state
  const buildQuery = useCallback(
    (pageNumber: number) => {
      const params = new URLSearchParams();
      params.set('source', 'shared');
      params.set('page_size', String(PAGE_SIZE));
      params.set('page', String(pageNumber));
      params.set('sort', sort);
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (category) params.set('category', category);
      if (gender) params.set('gender', gender);
      if (age) params.set('age', age);
      if (accent) params.set('accent', accent);
      if (language) params.set('language', language);
      if (useCase) params.set('use_cases', useCase);
      return params.toString();
    },
    [debouncedSearch, sort, category, gender, age, accent, language, useCase],
  );

  // Fetch a page of voices
  const fetchVoices = useCallback(
    async (pageNumber: number, replace: boolean) => {
      try {
        if (replace) setLoading(true);
        else setLoadingMore(true);
        setError(null);

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('You must be signed in to browse voices.');

        const url = `${import.meta.env.SUPABASE_URL}/functions/v1/elevenlabs-list-voices?${buildQuery(pageNumber)}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`ElevenLabs request failed (${res.status}): ${txt.slice(0, 160)}`);
        }

        const json = await res.json();
        const list: ElevenLabsVoice[] = json.voices ?? [];
        setHasMore(Boolean(json.has_more));
        setVoices((prev) => (replace ? list : [...prev, ...list]));
        if (replace) setTotalCount(typeof json.total_count === 'number' ? json.total_count : null);
        setPage(pageNumber);
      } catch (err: any) {
        setError(err?.message ?? 'Failed to load voices');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [buildQuery],
  );

  // Re-fetch from page 0 when filters change
  useEffect(() => {
    fetchVoices(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sort, category, gender, age, accent, language, useCase]);

  // Stop audio when component unmounts
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const togglePlay = (voice: ElevenLabsVoice) => {
    if (!voice.preview_url) return;
    if (playingVoiceId === voice.voice_id) {
      audioRef.current?.pause();
      setPlayingVoiceId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(voice.preview_url);
    audioRef.current = audio;
    audio.onended = () => setPlayingVoiceId(null);
    audio.onerror = () => setPlayingVoiceId(null);
    audio.play().then(() => setPlayingVoiceId(voice.voice_id)).catch(() => setPlayingVoiceId(null));
  };

  const handleSelect = (voice: ElevenLabsVoice) => {
    const compatibleModel = pickModelForVoice(modelId, voice.high_quality_base_model_ids);
    if (compatibleModel !== modelId) {
      setModelId(compatibleModel);
      onModelChange?.(compatibleModel);
    }
    onSelectVoice({
      voice_id: voice.voice_id,
      name: voice.name,
      model_id: compatibleModel,
      preview_url: voice.preview_url,
      high_quality_base_model_ids: voice.high_quality_base_model_ids,
      language: voice.language ?? voice.labels?.language,
    });
  };

  const clearFilters = () => {
    setCategory(null);
    setGender(null);
    setAge(null);
    setAccent(null);
    setLanguage(null);
    setUseCase(null);
    setSearch('');
  };

  const hasActiveFilters = useMemo(
    () => Boolean(category || gender || age || accent || language || useCase || debouncedSearch),
    [category, gender, age, accent, language, useCase, debouncedSearch],
  );

  // Hide voices that the currently selected model can't speak.
  // ElevenLabs returns `high_quality_base_model_ids` per voice; voices
  // without the field are assumed compatible (older API responses).
  const visibleVoices = useMemo(
    () =>
      voices.filter((v) => {
        const list = v.high_quality_base_model_ids;
        if (!list || list.length === 0) return true;
        return isModelCompatibleWithVoice(modelId, list);
      }),
    [voices, modelId],
  );

  // Infinite scroll sentinel
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          fetchVoices(page + 1, false);
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [page, hasMore, loading, loadingMore, fetchVoices]);

  const selectedModel = getElevenLabsModel(modelId);

  return (
    <div
      className={
        embedded
          ? ''
          : 'bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden'
      }
    >
      {/* Header */}
      <div
        className={
          embedded
            ? 'flex flex-col gap-4'
            : 'flex flex-col gap-4 px-4 sm:px-6 py-4 border-b border-zinc-800 bg-zinc-900/60'
        }
      >
        {!embedded && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 text-sm text-zinc-300 hover:text-white transition-colors px-3 py-2 rounded-lg hover:bg-zinc-800/60"
              aria-label="Back to all voices"
            >
              <ArrowLeft size={16} />
              Back
            </button>
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-accent-text" />
              <h2 className="text-white font-semibold text-base sm:text-lg">ElevenLabs Voice Library</h2>
            </div>
          </div>
        )}

        {/* Search + sort + model */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search voices…"
              className="w-full pl-9 pr-9 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:border-accent"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white"
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <SortListbox value={sort} onChange={setSort} />
          <ModelListbox
            value={modelId}
            onChange={(next) => {
              setModelId(next);
              onModelChange?.(next);
            }}
          />
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-2">
          <FilterDropdown label="Category" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} />
          <FilterDropdown label="Language" value={language} onChange={setLanguage} options={LANGUAGE_OPTIONS} />
          <FilterDropdown label="Gender" value={gender} onChange={setGender} options={GENDER_OPTIONS} />
          <FilterDropdown label="Age" value={age} onChange={setAge} options={AGE_OPTIONS} />
          <FilterDropdown label="Accent" value={accent} onChange={setAccent} options={ACCENT_OPTIONS} />
          <FilterDropdown label="Use case" value={useCase} onChange={setUseCase} options={USE_CASE_OPTIONS} />
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-zinc-300 hover:text-white px-2 py-1 rounded-md hover:bg-zinc-800/60"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Cost hint */}
        <div className="flex items-start gap-2 text-xs text-zinc-400">
          <Info size={12} className="mt-0.5 flex-shrink-0" />
          <span>
            {selectedModel.label} • {selectedModel.tokensPerChar} tokens per character (~$
            {((selectedModel.tokensPerChar * 1_000_000) / 1_000_000 * 0.000002 * 1000).toFixed(2)}/1k chars).
            Some voices are restricted to specific models — we'll auto-switch if needed.
          </span>
        </div>
      </div>

      {/* Body */}
      <div
        className={
          embedded
            ? 'mt-4 max-h-[60vh] overflow-y-auto pr-1'
            : 'p-4 sm:p-6 max-h-[calc(100vh-280px)] overflow-y-auto'
        }
      >
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && voices.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="animate-spin text-zinc-400" size={28} />
          </div>
        ) : visibleVoices.length === 0 ? (
          <div className="text-center py-16 text-zinc-400 text-sm">
            {voices.length === 0
              ? 'No voices match your filters.'
              : `No voices in this list support ${selectedModel?.label ?? 'the selected model'}. Try a different model or clear filters.`}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3 px-0.5">
              <p className="text-xs text-zinc-400">
                {totalCount !== null && totalCount > visibleVoices.length
                  ? `Showing ${visibleVoices.length} of ${totalCount.toLocaleString()} voices`
                  : `${visibleVoices.length} ${visibleVoices.length === 1 ? 'voice' : 'voices'}`}
                {voices.length > visibleVoices.length && (
                  <span className="text-zinc-500"> · {voices.length - visibleVoices.length} hidden by model</span>
                )}
              </p>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-xs text-zinc-300 hover:text-white underline-offset-2 hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleVoices.map((voice) => (
                <VoiceCard
                  key={voice.voice_id}
                  voice={voice}
                  isPlaying={playingVoiceId === voice.voice_id}
                  isSelected={currentSelectedVoiceId === voice.voice_id}
                  isCompatibleWithModel={isModelCompatibleWithVoice(modelId, voice.high_quality_base_model_ids)}
                  onPlay={() => togglePlay(voice)}
                  onSelect={() => handleSelect(voice)}
                />
              ))}
            </div>

            <div ref={sentinelRef} className="h-10" />
            {loadingMore && (
              <div className="flex justify-center py-4">
                <Loader2 className="animate-spin text-zinc-400" size={20} />
              </div>
            )}
            {!hasMore && voices.length > 0 && (
              <p className="text-center text-xs text-zinc-400 mt-4">No more voices.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VoiceCard({
  voice,
  isPlaying,
  isSelected,
  isCompatibleWithModel,
  onPlay,
  onSelect,
}: {
  voice: ElevenLabsVoice;
  isPlaying: boolean;
  isSelected: boolean;
  isCompatibleWithModel: boolean;
  onPlay: () => void;
  onSelect: () => void;
}) {
  const initials = voice.name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  const labels = voice.labels ?? {};
  const tagSet = new Set<string>();
  if (labels.gender) tagSet.add(cap(labels.gender));
  if (labels.age) tagSet.add(cap(labels.age.replace('_', ' ')));
  if (labels.accent) tagSet.add(cap(labels.accent));
  if (labels.use_case) tagSet.add(cap(labels.use_case.replace('_', ' ')));
  if (labels.descriptive) tagSet.add(cap(labels.descriptive));
  const tags = Array.from(tagSet).slice(0, 4);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      aria-pressed={isSelected}
      className={`group relative flex flex-col gap-3 p-4 rounded-xl border text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent cursor-pointer ${
        isSelected
          ? 'border-accent bg-accent/5'
          : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-900/80'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="relative flex-shrink-0">
          {voice.image_url ? (
            <img
              src={voice.image_url}
              alt=""
              className="w-12 h-12 rounded-lg object-cover bg-zinc-800"
            />
          ) : (
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-semibold text-sm shadow-inner"
              style={{
                backgroundImage: `linear-gradient(135deg, ${gradientFromId(voice.voice_id).from}, ${gradientFromId(voice.voice_id).to})`,
              }}
            >
              {initials || '?'}
            </div>
          )}
          {voice.preview_url && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPlay(); }}
              className={`absolute inset-0 flex items-center justify-center rounded-lg bg-black/55 transition-opacity ${
                isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
            >
              {isPlaying ? <Pause size={16} className="text-white" /> : <Play size={16} className="text-white" />}
            </button>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-white font-medium text-sm truncate">{voice.name}</h3>
            {voice.category && (
              <span className="text-[10px] uppercase tracking-wide text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded">
                {voice.category.replace('_', ' ')}
              </span>
            )}
          </div>
          {voice.description && (
            <p className="text-xs text-zinc-400 line-clamp-2 mt-0.5">{voice.description}</p>
          )}
        </div>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <span
              key={t}
              className="text-[10px] text-zinc-300 bg-zinc-800/70 px-2 py-0.5 rounded-full"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mt-auto pt-1">
        {!isCompatibleWithModel ? (
          <span className="text-[10px] text-amber-400">Will switch model on select</span>
        ) : (
          <span className="text-[10px] text-zinc-400 truncate">
            {voice.verified_languages?.length
              ? `${voice.verified_languages.length} languages`
              : voice.language ?? labels.language ?? ''}
          </span>
        )}
        {isSelected && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
            <Check size={12} /> Selected
          </span>
        )}
      </div>
    </div>
  );
}

function FilterDropdown({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: ChipOption[];
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <Listbox value={value} onChange={onChange}>
      <div className="relative">
        <Listbox.Button
          className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors ${
            value
              ? 'bg-accent/15 text-white border-accent/40'
              : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700'
          }`}
        >
          {label}
          {selected && <span className="text-white">: {selected.label}</span>}
          <ChevronDown size={12} />
        </Listbox.Button>
        <Transition
          as={React.Fragment}
          enter="transition ease-out duration-100"
          enterFrom="opacity-0 -translate-y-1"
          enterTo="opacity-100 translate-y-0"
          leave="transition ease-in duration-75"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Listbox.Options className="absolute z-30 mt-2 max-h-72 overflow-auto bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg py-1 min-w-[160px]">
            <Listbox.Option
              value={null}
              className={({ active }) =>
                `cursor-pointer px-3 py-1.5 text-xs ${active ? 'bg-zinc-800 text-white' : 'text-zinc-300'}`
              }
            >
              Any
            </Listbox.Option>
            {options.map((opt) => (
              <Listbox.Option
                key={opt.value}
                value={opt.value}
                className={({ active, selected }) =>
                  `cursor-pointer px-3 py-1.5 text-xs flex items-center gap-2 ${
                    active ? 'bg-zinc-800 text-white' : selected ? 'text-white' : 'text-zinc-300'
                  }`
                }
              >
                {({ selected }) => (
                  <>
                    {selected && <Check size={12} />}
                    <span className={selected ? '' : 'pl-4'}>{opt.label}</span>
                  </>
                )}
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </Transition>
      </div>
    </Listbox>
  );
}

function SortListbox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const current = SORT_OPTIONS.find((s) => s.value === value) ?? SORT_OPTIONS[0];
  return (
    <Listbox value={value} onChange={onChange}>
      <div className="relative">
        <Listbox.Button className="inline-flex items-center gap-2 text-xs text-white bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 hover:border-zinc-700 transition-colors min-w-[140px] justify-between">
          <span>Sort: {current.label}</span>
          <ChevronDown size={14} />
        </Listbox.Button>
        <Transition
          as={React.Fragment}
          leave="transition ease-in duration-75"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Listbox.Options className="absolute right-0 z-30 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg py-1 min-w-[160px]">
            {SORT_OPTIONS.map((opt) => (
              <Listbox.Option
                key={opt.value}
                value={opt.value}
                className={({ active, selected }) =>
                  `cursor-pointer px-3 py-1.5 text-xs flex items-center gap-2 ${
                    active ? 'bg-zinc-800 text-white' : selected ? 'text-white' : 'text-zinc-300'
                  }`
                }
              >
                {({ selected }) => (
                  <>
                    {selected ? <Check size={12} /> : <span className="w-3" />}
                    {opt.label}
                  </>
                )}
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </Transition>
      </div>
    </Listbox>
  );
}

function ModelListbox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const current = getElevenLabsModel(value);
  return (
    <Listbox value={value} onChange={onChange}>
      <div className="relative">
        <Listbox.Button className="inline-flex items-center gap-2 text-xs text-white bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 hover:border-zinc-700 transition-colors min-w-[180px] justify-between">
          <span>Model: {current.label}</span>
          <ChevronDown size={14} />
        </Listbox.Button>
        <Transition
          as={React.Fragment}
          leave="transition ease-in duration-75"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Listbox.Options className="absolute right-0 z-30 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-lg py-1 min-w-[260px]">
            {ELEVENLABS_MODELS.map((m) => (
              <Listbox.Option
                key={m.id}
                value={m.id}
                className={({ active, selected }) =>
                  `cursor-pointer px-3 py-2 text-xs ${
                    active ? 'bg-zinc-800' : ''
                  } ${selected ? 'text-white' : 'text-zinc-300'}`
                }
              >
                {({ selected }) => (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 text-white">
                      {selected ? <Check size={12} /> : <span className="w-3" />}
                      <span className="font-medium">{m.label}</span>
                      <span className="text-[10px] text-zinc-400">{m.tokensPerChar} tok/char</span>
                    </div>
                    <span className="pl-5 text-zinc-400">{m.description}</span>
                  </div>
                )}
              </Listbox.Option>
            ))}
          </Listbox.Options>
        </Transition>
      </div>
    </Listbox>
  );
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Deterministically derive a 2-stop gradient from a voice id so the same voice
 * always renders with the same colors but distinct voices look visually
 * different in a grid. Saturation/lightness are fixed so nothing clashes with
 * the surrounding zinc surfaces and white initials stay readable.
 */
function gradientFromId(id: string): { from: string; to: string } {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(h) % 360;
  const h2 = (h1 + 40) % 360;
  return {
    from: `hsl(${h1} 60% 42%)`,
    to: `hsl(${h2} 55% 22%)`,
  };
}
