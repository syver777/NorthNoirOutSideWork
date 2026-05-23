import React, { Fragment } from 'react';
import { Listbox, Transition } from '@headlessui/react';
import { Captions, Check, ChevronDown } from 'lucide-react';

export type SubtitleMode = 'phrase' | 'karaoke' | 'single_word';
export type SubtitlePosition = 'bottom' | 'center' | 'top';

export interface SubtitleConfig {
  font_idx: number;   // 1..10
  color_idx: number;  // 1..10
  size_idx: number;   // 1..10
  mode: SubtitleMode;
  position: SubtitlePosition;
}

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  font_idx: 4,   // Montserrat Black
  color_idx: 1,  // Classic White
  size_idx: 5,   // 64px
  mode: 'phrase',
  position: 'bottom',
};

// Mirrors gcloudfunctions/subtitles.py — keep in sync.
const FONTS: { idx: number; label: string }[] = [
  { idx: 1,  label: 'Montserrat' },
  { idx: 2,  label: 'Bebas Neue' },
  { idx: 3,  label: 'Anton' },
  { idx: 4,  label: 'Montserrat Black' },
  { idx: 5,  label: 'Poppins' },
  { idx: 6,  label: 'Oswald' },
  { idx: 7,  label: 'Lobster' },
  { idx: 8,  label: 'Permanent Marker' },
  { idx: 9,  label: 'Bangers' },
  { idx: 10, label: 'Oswald Bold' },
];

const COLOR_PRESETS: { idx: number; label: string; swatch: string; stroke: string }[] = [
  { idx: 1,  label: 'Classic White',   swatch: '#FFFFFF', stroke: '#000000' },
  { idx: 2,  label: 'Cinema Yellow',   swatch: '#FFF000', stroke: '#000000' },
  { idx: 3,  label: 'Soft Shadow',     swatch: '#FFFFFF', stroke: '#000000' },
  { idx: 4,  label: 'Inverse',         swatch: '#000000', stroke: '#FFFFFF' },
  { idx: 5,  label: 'Boxed Caption',   swatch: '#FFFFFF', stroke: '#000000' },
  { idx: 6,  label: 'Synthwave',       swatch: '#00FFFF', stroke: '#330066' },
  { idx: 7,  label: 'Premium Gold',    swatch: '#FFC800', stroke: '#663300' },
  { idx: 8,  label: 'Alert Red',       swatch: '#FF0000', stroke: '#FFFFFF' },
  { idx: 9,  label: 'Sunset',          swatch: '#FFF000', stroke: '#FF8000' },
  { idx: 10, label: 'Classic Black',   swatch: '#000000', stroke: '#FFFFFF' },
];

const SIZES = [32, 40, 48, 56, 64, 72, 84, 96, 112, 128];

const MODE_OPTIONS: { value: SubtitleMode; label: string; hint: string }[] = [
  { value: 'phrase',      label: 'Phrase',      hint: '4–7 words per cue' },
  { value: 'karaoke',     label: 'Karaoke',     hint: 'Per-word color sweep' },
  { value: 'single_word', label: 'Single Word', hint: 'One word at a time' },
];

const POSITION_OPTIONS: { value: SubtitlePosition; label: string }[] = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'center', label: 'Center' },
  { value: 'top',    label: 'Top' },
];

const inputClass =
  'relative w-full bg-surface-elevated border border-border rounded-lg px-4 py-2.5 text-left text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50';

export interface SubtitleConfigurationProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  config: SubtitleConfig;
  onConfigChange: (config: SubtitleConfig) => void;
  disabled?: boolean;
}

const SubtitleConfiguration: React.FC<SubtitleConfigurationProps> = ({
  enabled,
  onEnabledChange,
  config,
  onConfigChange,
  disabled = false,
}) => {
  const update = <K extends keyof SubtitleConfig>(key: K, value: SubtitleConfig[K]) => {
    onConfigChange({ ...config, [key]: value });
  };

  const activeFont = FONTS.find((f) => f.idx === config.font_idx) ?? FONTS[3];
  const activeColor = COLOR_PRESETS.find((c) => c.idx === config.color_idx) ?? COLOR_PRESETS[0];

  return (
    <div className="space-y-4">
      {/* Section header + master toggle */}
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div className="flex items-center min-w-0">
          <Captions className="h-5 w-5 text-red-700 mr-2 flex-shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <label
              htmlFor="subtitles-toggle"
              className="text-base font-semibold text-white block cursor-pointer"
            >
              Subtitles
            </label>
            <p className="text-xs text-text-muted mt-0.5">
              Optional captions burned into the final video. Off by default.
            </p>
          </div>
        </div>
        <button
          id="subtitles-toggle"
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? 'Disable subtitles' : 'Enable subtitles'}
          disabled={disabled}
          onClick={() => onEnabledChange(!enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-red-900/60 ${
            enabled
              ? 'bg-red-900/60 border-red-800/70'
              : 'bg-surface-elevated border-border'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-[1px] ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Detail panel — only when enabled */}
      {enabled && (
        <div className="border border-red-800/40 bg-red-900/10 rounded-xl p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Font */}
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1.5">Font</label>
              <Listbox
                value={config.font_idx}
                onChange={(v: number) => update('font_idx', v)}
                disabled={disabled}
              >
                <div className="relative">
                  <Listbox.Button className={`${inputClass} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
                    <span className="block truncate">{activeFont.label}</span>
                    <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                      <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden="true" />
                    </span>
                  </Listbox.Button>
                  <Transition as={Fragment} leave="transition ease-in duration-100" leaveFrom="opacity-100" leaveTo="opacity-0">
                    <Listbox.Options className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg bg-surface-elevated border border-border py-1 text-sm shadow-lg focus:outline-none">
                      {FONTS.map((f) => (
                        <Listbox.Option
                          key={f.idx}
                          value={f.idx}
                          className={({ active }) =>
                            `relative cursor-pointer select-none py-2 pl-9 pr-3 ${
                              active ? 'bg-red-900/30 text-white' : 'text-white/90'
                            }`
                          }
                        >
                          {({ selected }) => (
                            <>
                              <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                {f.label}
                              </span>
                              {selected && (
                                <span className="absolute inset-y-0 left-0 flex items-center pl-2 text-red-400">
                                  <Check className="h-4 w-4" aria-hidden="true" />
                                </span>
                              )}
                            </>
                          )}
                        </Listbox.Option>
                      ))}
                    </Listbox.Options>
                  </Transition>
                </div>
              </Listbox>
            </div>

            {/* Color preset */}
            <div>
              <label className="text-xs font-medium text-text-muted block mb-1.5">Color Style</label>
              <Listbox
                value={config.color_idx}
                onChange={(v: number) => update('color_idx', v)}
                disabled={disabled}
              >
                <div className="relative">
                  <Listbox.Button className={`${inputClass} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="h-4 w-4 rounded-full border border-white/20 flex-shrink-0"
                        style={{ background: activeColor.swatch, boxShadow: `inset 0 0 0 1px ${activeColor.stroke}` }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{activeColor.label}</span>
                    </span>
                    <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                      <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden="true" />
                    </span>
                  </Listbox.Button>
                  <Transition as={Fragment} leave="transition ease-in duration-100" leaveFrom="opacity-100" leaveTo="opacity-0">
                    <Listbox.Options className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg bg-surface-elevated border border-border py-1 text-sm shadow-lg focus:outline-none">
                      {COLOR_PRESETS.map((p) => (
                        <Listbox.Option
                          key={p.idx}
                          value={p.idx}
                          className={({ active }) =>
                            `relative cursor-pointer select-none py-2 pl-9 pr-3 ${
                              active ? 'bg-red-900/30 text-white' : 'text-white/90'
                            }`
                          }
                        >
                          {({ selected }) => (
                            <>
                              <span className="flex items-center gap-2">
                                <span
                                  className="h-4 w-4 rounded-full border border-white/20 flex-shrink-0"
                                  style={{ background: p.swatch, boxShadow: `inset 0 0 0 1px ${p.stroke}` }}
                                  aria-hidden="true"
                                />
                                <span className={`block truncate ${selected ? 'font-medium' : 'font-normal'}`}>
                                  {p.label}
                                </span>
                              </span>
                              {selected && (
                                <span className="absolute inset-y-0 left-0 flex items-center pl-2 text-red-400">
                                  <Check className="h-4 w-4" aria-hidden="true" />
                                </span>
                              )}
                            </>
                          )}
                        </Listbox.Option>
                      ))}
                    </Listbox.Options>
                  </Transition>
                </div>
              </Listbox>
            </div>

            {/* Size */}
            <div>
              <label htmlFor="subtitle-size" className="text-xs font-medium text-text-muted flex items-center justify-between mb-1.5">
                <span>Size</span>
                <span className="text-text-muted/80 tabular-nums">{SIZES[config.size_idx - 1]}px @ 1080p</span>
              </label>
              <input
                id="subtitle-size"
                type="range"
                min={1}
                max={SIZES.length}
                step={1}
                value={config.size_idx}
                onChange={(e) => update('size_idx', parseInt(e.target.value, 10))}
                disabled={disabled}
                className={`w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer slider ${
                  disabled ? 'cursor-not-allowed opacity-50' : ''
                }`}
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-1">
                <span>Small</span>
                <span className="hidden sm:inline">Medium</span>
                <span>Large</span>
              </div>
            </div>

            {/* Position */}
            <div>
              <span className="text-xs font-medium text-text-muted block mb-1.5">Position</span>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Subtitle position">
                {POSITION_OPTIONS.map((opt) => {
                  const active = config.position === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => update('position', opt.value)}
                      disabled={disabled}
                      className={`text-sm py-2 rounded-lg border transition focus:outline-none focus:ring-2 focus:ring-red-900/60 ${
                        active
                          ? 'border-red-800/70 bg-red-900/30 text-white'
                          : 'bg-surface-elevated border-border text-white/80 hover:border-red-800/40'
                      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Mode (full width) */}
          <div>
            <span className="text-xs font-medium text-text-muted block mb-1.5">Caption Style</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Caption style">
              {MODE_OPTIONS.map((opt) => {
                const active = config.mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => update('mode', opt.value)}
                    disabled={disabled}
                    className={`text-left p-3 rounded-lg border transition focus:outline-none focus:ring-2 focus:ring-red-900/60 ${
                      active
                        ? 'border-red-800/70 bg-red-900/30'
                        : 'bg-surface-elevated border-border hover:border-red-800/40'
                    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <div className="text-sm font-medium text-white">{opt.label}</div>
                    <div className="text-xs text-text-muted mt-0.5">{opt.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-text-muted">
            Captions are timed from the narration audio. Adds a short post-render step; no extra cost when disabled.
          </p>
        </div>
      )}
    </div>
  );
};

export default SubtitleConfiguration;
