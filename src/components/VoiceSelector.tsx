import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, User, Upload, X, Trash2, CheckCircle2, ChevronDown, AlertCircle, AlertTriangle, FileAudio, Lock, Info } from 'lucide-react';
import { Listbox, Transition } from '@headlessui/react';
import { createClient } from '@supabase/supabase-js';
import ElevenLabsVoiceBrowser, { type SelectedElevenLabsVoice } from './ElevenLabsVoiceBrowser';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

interface VoiceSelectorProps {
  selectedVoice: string;
  onVoiceSelect: (voice: string) => void;
  playingVoice: string | null;
  onPlaySample: (voice: string) => void;
  disabled?: boolean;
  userPlan: string;
  userId: string;
  onCloneVoiceCreated?: (voiceId: string, filePath: string) => void;
  /** When true, Core voices are disabled because the story contains TTS pauses */
  pauseRestricted?: boolean;
  /** Display label for the currently-selected ElevenLabs voice, if any. */
  elevenLabsSelectedLabel?: string | null;
  /** Currently selected ElevenLabs voice id (if any) for highlighting in the embedded browser. */
  elevenLabsCurrentVoiceId?: string;
  /** Currently selected ElevenLabs model id (defaults handled by browser if omitted). */
  elevenLabsModelId?: string;
  /** Called when the user picks an ElevenLabs voice in the embedded browser. */
  onSelectElevenLabsVoice?: (voice: SelectedElevenLabsVoice) => void;
  /** Called when the user changes the ElevenLabs model dropdown. */
  onElevenLabsModelChange?: (modelId: string) => void;
  /** When true, the ElevenLabs tier is hidden entirely (e.g. on video generator pages). */
  hideElevenLabs?: boolean;
}

interface CloneVoice {
  id: string;
  name: string;
  voice_id: string;
  language: string;
  audio_url?: string;
  user_id?: string;
  created_at?: string;
  is_custom: boolean;
}

// UPDATED: Interface for uploaded voice data
interface UploadedVoiceData {
  file: File;
  voiceId: string; // Actual voice ID from Inworld
  displayName: string; // Original file name for display
  filePath: string; // Storage file path
}

const coreVoices = [
  { name: "lewis", type: "core", language: "english" },
  { name: "george", type: "core", language: "english" },
  { name: "fable", type: "core", language: "english" },
  { name: "daniel", type: "core", language: "english" },
  { name: "lily", type: "core", language: "english" },
  { name: "isabella", type: "core", language: "english" },
  { name: "emma", type: "core", language: "english" },
  { name: "alice", type: "core", language: "english" },
  { name: "santa", type: "core", language: "english" },
  { name: "adam", type: "core", language: "english" },
  { name: "puck", type: "core", language: "english" },
  { name: "onyx", type: "core", language: "english" },
  { name: "liam", type: "core", language: "english" },
  { name: "fenrir", type: "core", language: "english" },
  { name: "eric", type: "core", language: "english" },
  { name: "echo", type: "core", language: "english" },
  { name: "sky", type: "core", language: "english" },
  { name: "sarah", type: "core", language: "english" },
  { name: "river", type: "core", language: "english" },
  { name: "nova", type: "core", language: "english" },
  { name: "nicole", type: "core", language: "english" },
  { name: "jessica", type: "core", language: "english" },
  { name: "kore", type: "core", language: "english" },
  { name: "aoede", type: "core", language: "english" },
  { name: "alloy", type: "core", language: "english" },
  { name: "michael", type: "core", language: "english" },
  { name: "bella", type: "core", language: "english" },
  { name: "heart", type: "core", language: "english" }
];

const premiumVoices = [
  { name: "Alex", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Ashley", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Craig", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Deborah", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Dennis", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Edward", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Elizabeth", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Hades", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Julia", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Pixie", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Mark", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Olivia", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Priya", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Ronald", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Sarah", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Shaun", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Theodore", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Timothy", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Wendy", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Dominus", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Hana", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Clive", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Carter", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Blake", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Luna", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Loretta", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Darlene", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Marlene", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Hank", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Evelyn", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Celeste", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Abby", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Mortimer", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Snik", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Claire", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Oliver", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Simon", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Elliot", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "James", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Serena", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Gareth", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Vinny", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Lauren", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Jessica", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Ethan", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Tyler", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Jason", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Chloe", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Veronica", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Miranda", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Sebastian", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Victor", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Malcolm", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Nate", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Brian", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Amina", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Kelsey", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Derek", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Evan", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Kayla", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Jake", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Grant", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Tristan", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Nadia", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Selene", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Marcus", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Riley", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Damon", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Cedric", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Mia", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Naomi", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Jonah", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Levi", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Avery", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Brandon", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Conrad", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Bianca", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Lucian", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Trevor", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Reed", type: "premium", language: "american english", flag: "🇺🇸" },
  { name: "Pippa", type: "premium", language: "australian english", flag: "🇦🇺" },
  { name: "Tessa", type: "premium", language: "australian english", flag: "🇦🇺" },
  { name: "Liam", type: "premium", language: "australian english", flag: "🇦🇺" },
  { name: "Callum", type: "premium", language: "australian english", flag: "🇦🇺" },
  { name: "Hamish", type: "premium", language: "australian english", flag: "🇦🇺" },
  { name: "Graham", type: "premium", language: "british english", flag: "🇬🇧" },
  { name: "Rupert", type: "premium", language: "british english", flag: "🇬🇧" },
  { name: "Victoria", type: "premium", language: "british english", flag: "🇬🇧" },
  { name: "Duncan", type: "premium", language: "british english", flag: "🇬🇧" },
  { name: "Felix", type: "premium", language: "british english", flag: "🇬🇧" },
  { name: "Eleanor", type: "premium", language: "british english", flag: "🇬🇧" },
  { name: "Sophie", type: "premium", language: "british english", flag: "🇬🇧" },
  { name: "Anjali", type: "premium", language: "indian english", flag: "🇮🇳" },
  { name: "Saanvi", type: "premium", language: "indian english", flag: "🇮🇳" },
  { name: "Arjun", type: "premium", language: "indian english", flag: "🇮🇳" },
  { name: "Yichen", type: "premium", language: "mandarin chinese", flag: "🇨🇳" },
  { name: "Xiaoyin", type: "premium", language: "mandarin chinese", flag: "🇨🇳" },
  { name: "Xinyi", type: "premium", language: "mandarin chinese", flag: "🇨🇳" },
  { name: "Jing", type: "premium", language: "mandarin chinese", flag: "🇨🇳" },
  { name: "Erik", type: "premium", language: "dutch", flag: "🇳🇱" },
  { name: "Katrien", type: "premium", language: "dutch", flag: "🇳🇱" },
  { name: "Lennart", type: "premium", language: "dutch", flag: "🇳🇱" },
  { name: "Lore", type: "premium", language: "dutch", flag: "🇳🇱" },
  { name: "Alain", type: "premium", language: "french", flag: "🇫🇷" },
  { name: "Hélène", type: "premium", language: "french", flag: "🇫🇷" },
  { name: "Mathieu", type: "premium", language: "french", flag: "🇫🇷" },
  { name: "Étienne", type: "premium", language: "french", flag: "🇫🇷" },
  { name: "Johanna", type: "premium", language: "german", flag: "🇩🇪" },
  { name: "Josef", type: "premium", language: "german", flag: "🇩🇪" },
  { name: "Gianni", type: "premium", language: "italian", flag: "🇮🇹" },
  { name: "Orietta", type: "premium", language: "italian", flag: "🇮🇹" },
  { name: "Asuka", type: "premium", language: "japanese", flag: "🇯🇵" },
  { name: "Satoshi", type: "premium", language: "japanese", flag: "🇯🇵" },
  { name: "Hyunwoo", type: "premium", language: "korean", flag: "🇰🇷" },
  { name: "Minji", type: "premium", language: "korean", flag: "🇰🇷" },
  { name: "Seojun", type: "premium", language: "korean", flag: "🇰🇷" },
  { name: "Yoona", type: "premium", language: "korean", flag: "🇰🇷" },
  { name: "Szymon", type: "premium", language: "polish", flag: "🇵🇱" },
  { name: "Wojciech", type: "premium", language: "polish", flag: "🇵🇱" },
  { name: "Heitor", type: "premium", language: "brazilian portuguese", flag: "🇧🇷" },
  { name: "Maitê", type: "premium", language: "brazilian portuguese", flag: "🇧🇷" },
  { name: "Diego", type: "premium", language: "spanish", flag: "🇪🇸" },
  { name: "Lupita", type: "premium", language: "spanish", flag: "🇪🇸" },
  { name: "Miguel", type: "premium", language: "spanish", flag: "🇪🇸" },
  { name: "Rafael", type: "premium", language: "spanish", flag: "🇪🇸" },
  { name: "Svetlana", type: "premium", language: "russian", flag: "🇷🇺" },
  { name: "Elena", type: "premium", language: "russian", flag: "🇷🇺" },
  { name: "Dmitry", type: "premium", language: "russian", flag: "🇷🇺" },
  { name: "Nikolai", type: "premium", language: "russian", flag: "🇷🇺" },
  { name: "Riya", type: "premium", language: "hindi", flag: "🇮🇳" },
  { name: "Manoj", type: "premium", language: "hindi", flag: "🇮🇳" },
  { name: "Nour", type: "premium", language: "arabic", flag: "🇸🇦" },
  { name: "Omar", type: "premium", language: "arabic", flag: "🇸🇦" },
  { name: "Yael", type: "premium", language: "hebrew", flag: "🇮🇱" },
  { name: "Oren", type: "premium", language: "hebrew", flag: "🇮🇱" }
];

const apexVoices = [
  // American English
  { name: "oliver", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "erin", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "rob", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "jesse", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "ken", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "lindsey", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "monica", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "stacy", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "james", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "christina", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "douglas", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "patricia", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "peter", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "jeremy", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "barbara", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "donald", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "paul", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "timothy", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "dorothy", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "gary", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "cynthia", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "belinda", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "dylan", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "hugo", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "kurt", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "sherman", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "allan", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "jacquelin", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "glenda", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "sherrie", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "becky", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "jenna", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "faye", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "jaclyn", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "meredith", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "melinda", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "isabel", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "rubye", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "janelle", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "constance", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "deanna", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "josie", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "ronda", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "alton", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "cesar", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "grant", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "lionel", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "wilbur", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "lester", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "matt", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "lyle", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "hubert", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "kenny", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "doug", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "woodrow", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "marco", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "rufus", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "abraham", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "irving", type: "apex", language: "american english", flag: "🇺🇸" },
  { name: "julius", type: "apex", language: "american english", flag: "🇺🇸" },
  // British English
  { name: "benjamin", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "ron", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "phil", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "collin", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "helen", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "carol", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "harvey", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "gordon", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "wilma", type: "apex", language: "british english", flag: "🇬🇧" },
  { name: "wanda", type: "apex", language: "british english", flag: "🇬🇧" },
  // Australian English
  { name: "linda", type: "apex", language: "australian english", flag: "🇦🇺" },
  { name: "kim", type: "apex", language: "australian english", flag: "🇦🇺" },
  // Mexican Spanish
  { name: "juan-pablo", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "gael", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "valeria", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "emmanuel", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "jose-manuel", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "lizbeth", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "romina", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "rafael", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "matias", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "juan-carlos", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "fernando", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "daniela", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "jose-angel", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "mariana", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "carolina", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "emiliano", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "jesus", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "angel", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "aitana", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "maximiliano", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "estefania", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "yamileth", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "jimena", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "luciana", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "ivanna", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "jose-luis", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "miguel-angel", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "luis-angel", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "julieta", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "alejandra", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "esmeralda", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "alondra", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "alexa", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "danna-sofia", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "celia", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "carlos", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "carmen", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  { name: "alejandro", type: "apex", language: "mexican spanish", flag: "🇲🇽" },
  // German
  { name: "heidi-speechify", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "anni", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "luca", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "anton", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "gabriel-de", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "nico", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "mathilda", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "philipp", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "merle", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "moritz", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "melina", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "thea", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "nele", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "jasper", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "louis", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "ben", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "oskar", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "ronja", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "pepe", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "amalia", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "matteo", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "juna", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "lina", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "greta", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "elina", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "linus", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "jonathan-de", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "mila", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "ella", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "pia", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "maximilian", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "milan", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "amelie", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "luisa", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "jannik", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "hannes", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "andra", type: "apex", language: "german", flag: "🇩🇪" },
  { name: "frederick", type: "apex", language: "german", flag: "🇩🇪" },
  // French
  { name: "angele", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "adeline", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "anais", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "angelique", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "eliane", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "jules", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "sacha", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "gabin", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "marius", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "clement", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "nael", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "mael", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "agathe", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "evelyne", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "carine", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "delphine", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "estelle", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "eugenie", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "eden", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "rayan", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "mathis", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "tiago", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "ibrahim", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "elisabeth", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "maxime", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "ayden", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "lenny", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "alexandre", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "amir", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "imran", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "cecile", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "christelle", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "dominique", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "nino", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "aline", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "augustine", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "kylian", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "aurelie", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "emilie", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "enzo", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "noe", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "camille", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "claudine", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "valentin", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "elise", type: "apex", language: "french", flag: "🇫🇷" },
  { name: "raphael", type: "apex", language: "french", flag: "🇫🇷" }
];

// Predefined clone voices (updated with correct names from Python file)
const predefinedCloneVoices: CloneVoice[] = [
  { id: "clone1", name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan", language: "english", is_custom: false },
  { id: "clone2", name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian", language: "english", is_custom: false },
  { id: "clone3", name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred", language: "english", is_custom: false },
  { id: "clone4", name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad", language: "english", is_custom: false },
  { id: "clone5", name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo", language: "english", is_custom: false },
  { id: "clone6", name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder", language: "english", is_custom: false },
  { id: "clone7", name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor", language: "english", is_custom: false }
];

// ADDED: Clone voice languages with proper display names and flags
const cloneLanguages = [
  { code: 'english', name: 'English (US)', flag: '🇺🇸' },
  { code: 'chinese', name: 'Chinese (China)', flag: '🇨🇳' },
  { code: 'korean', name: 'Korean (Korea)', flag: '🇰🇷' },
  { code: 'japanese', name: 'Japanese (Japan)', flag: '🇯🇵' },
  { code: 'russian', name: 'Russian (Russia)', flag: '🇷🇺' },
  { code: 'auto', name: 'Auto-detect', flag: '🌍' },
  { code: 'italian', name: 'Italian (Italy)', flag: '🇮🇹' },
  { code: 'spanish', name: 'Spanish (Spain)', flag: '🇪🇸' },
  { code: 'portuguese', name: 'Portuguese (Brazil)', flag: '🇧🇷' },
  { code: 'german', name: 'German (Germany)', flag: '🇩🇪' },
  { code: 'french', name: 'French (France)', flag: '🇫🇷' },
  { code: 'arabic', name: 'Arabic (Saudi Arabia)', flag: '🇸🇦' },
  { code: 'polish', name: 'Polish (Poland)', flag: '🇵🇱' },
  { code: 'dutch', name: 'Dutch (Netherlands)', flag: '🇳🇱' },
  { code: 'hindi', name: 'Hindi (India)', flag: '🇮🇳' },
  { code: 'hebrew', name: 'Hebrew (Israel)', flag: '🇮🇱' }
];

const coreVoiceSamples: Record<string, string> = coreVoices.reduce((acc, v) => {
  acc[`core:${v.name}`] = `https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/core/${v.name}.mp3`;
  return acc;
}, {} as Record<string, string>);

// Helper function to remove diacritical marks for file paths
const removeDiacritics = (str: string): string => {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
};

const premiumVoiceSamples: Record<string, string> = premiumVoices.reduce((acc, v) => {
  const sanitizedName = removeDiacritics(v.name);
  acc[`premium:${v.name}`] = `https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/${sanitizedName}_example.mp3`;
  return acc;
}, {} as Record<string, string>);

const formatLanguageForUrl = (language: string): string => {
  return language.replace(/\s+/g, '_');
};

const apexVoiceSamples: Record<string, string> = apexVoices.reduce((acc, v) => {
  acc[`apex:${v.name}`] = `https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Apex/${v.name}_${formatLanguageForUrl(v.language)}.mp3`;
  return acc;
}, {} as Record<string, string>);

const cloneVoiceSamples: Record<string, string> = {
  "clone:Declan": "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/voiceClones/Declan.mp3",
  "clone:Adrian": "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/voiceClones/Adrian.mp3",
  "clone:Alfred": "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/voiceClones/Alfred.mp3",
  "clone:Conrad": "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/voiceClones/Conrad.mp3",
  "clone:Hugo": "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/voiceClones/Hugo.mp3",
  "clone:Ryder": "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/voiceClones/Ryder.mp3",
  "clone:Victor": "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/voiceClones/Victor.mp3"
};

// Helper function to format voice names for display
const formatVoiceName = (name: string): string => {
  return name
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
};

// Helper function to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const VoiceSelector = React.forwardRef<
  { clearUploadSection: () => void },
  VoiceSelectorProps
>(({
  selectedVoice,
  onVoiceSelect,
  playingVoice,
  onPlaySample,
  disabled = false,
  userPlan,
  userId,
  onCloneVoiceCreated,
  pauseRestricted = false,
  elevenLabsSelectedLabel = null,
  elevenLabsCurrentVoiceId,
  elevenLabsModelId,
  onSelectElevenLabsVoice,
  onElevenLabsModelChange,
  hideElevenLabs = false,
}, ref) => {
  // Show more states for each voice type
  const [showMoreCoreVoices, setShowMoreCoreVoices] = useState(false);
  const [showMorePremiumVoices, setShowMorePremiumVoices] = useState(false);
  const [showMoreApexVoices, setShowMoreApexVoices] = useState(false);
  const [showMoreCloneVoices, setShowMoreCloneVoices] = useState(false);

  // Language filters for Premium and Apex voices
  const [selectedPremiumLanguage, setSelectedPremiumLanguage] = useState<string>('all');
  const [selectedApexLanguage, setSelectedApexLanguage] = useState<string>('all');

  // ADDED: Language filter for Clone voices
  const [selectedCloneLanguage, setSelectedCloneLanguage] = useState<string>('english');

  // Clone voice states - UPDATED: Changed to use UploadedVoiceData interface
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // UPDATED: Use new interface for uploaded voice data
  const [uploadedVoice, setUploadedVoice] = useState<UploadedVoiceData | null>(null);

  // Audio playback states
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Accordion state — only one tier open at a time
  const [expandedTier, setExpandedTier] = useState<string | null>(() => {
    if (selectedVoice.startsWith('premium:')) return 'premium';
    if (selectedVoice.startsWith('clone:')) return 'clone';
    if (selectedVoice.startsWith('apex:')) return 'apex';
    if (selectedVoice.startsWith('elevenlabs:')) return 'elevenlabs';
    return 'core'; // Default to Core expanded
  });

  const toggleTier = (tier: string) => {
    setExpandedTier(prev => prev === tier ? null : tier);
  };

  // Get voice display name from key
  const getVoiceDisplayName = (voiceKey: string): string => {
    if (!voiceKey) return '';
    const [type, name] = voiceKey.split(':');
    if (type === 'apex') return formatVoiceName(name);
    return name;
  };

  // CHANGED: Check if user is on free plan
  const isFreeUser = userPlan === 'free';
  const isPaidUser = !isFreeUser; // CHANGED: Renamed for clarity

  // Get unique languages for filters
  // Build flag-aware language lists from voice data
  const premiumLanguages = [
    { code: 'all', name: 'All Languages', flag: '🌍' },
    ...Array.from(new Map(premiumVoices.map(v => [v.language, { code: v.language, name: v.language.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), flag: v.flag }]))).map(([, v]) => v)
  ];
  const apexLanguages = [
    { code: 'all', name: 'All Languages', flag: '🌍' },
    ...Array.from(new Map(apexVoices.map(v => [v.language, { code: v.language, name: v.language.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), flag: v.flag }]))).map(([, v]) => v)
  ];

  // Filter voices based on selected language
  const getFilteredPremiumVoices = () => {
    if (selectedPremiumLanguage === 'all') return premiumVoices;
    return premiumVoices.filter(v => v.language === selectedPremiumLanguage);
  };

  const getFilteredApexVoices = () => {
    if (selectedApexLanguage === 'all') return apexVoices;
    return apexVoices.filter(v => v.language === selectedApexLanguage);
  };

  // Display voices (first 6 or all if showMore is true)
  const displayedCoreVoices = showMoreCoreVoices ? coreVoices : coreVoices.slice(0, 6);
  const displayedPremiumVoices = showMorePremiumVoices ? getFilteredPremiumVoices() : getFilteredPremiumVoices().slice(0, 6);
  const displayedApexVoices = showMoreApexVoices ? getFilteredApexVoices() : getFilteredApexVoices().slice(0, 6);

  // CHANGED: Only show predefined clone voices in main grid
  const displayedCloneVoices = showMoreCloneVoices ? predefinedCloneVoices : predefinedCloneVoices.slice(0, 6);

  // Combine all voice samples
  const voiceSamples = { 
    ...coreVoiceSamples, 
    ...premiumVoiceSamples, 
    ...apexVoiceSamples,
    ...cloneVoiceSamples
  };

  // Audio playback handler
  const handlePlaySample = (voiceKey: string) => {
    if (currentlyPlaying === voiceKey) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setCurrentlyPlaying(null);
      onPlaySample('');
      return;
    }

    const url = voiceSamples[voiceKey];
    if (!url) return;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }

    audioRef.current = new Audio(url);
    audioRef.current.play().catch(console.error);
    
    setCurrentlyPlaying(voiceKey);
    onPlaySample(voiceKey);
    
    audioRef.current.onended = () => {
      setCurrentlyPlaying(null);
      onPlaySample('');
    };
  };

  // UPDATED: Function to clear upload section
  const clearUploadSection = () => {
    setUploadedVoice(null);
    setUploadError(null);
    setUploadingVoice(false);
    
    // Clear file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // UPDATED: Expose clearUploadSection to parent component using useImperativeHandle
  React.useImperativeHandle(ref, () => ({
    clearUploadSection
  }), []);

  const validateAudioFile = (file: File): string | null => {
    // Check file type
    const validTypes = ['audio/mp3', 'audio/wav', 'audio/m4a', 'audio/mpeg'];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(mp3|wav|m4a)$/i)) {
      return 'Please upload an MP3, WAV, or M4A audio file.';
    }

    // Check file size (max 4MB)
    const maxSize = 4 * 1024 * 1024; // 4MB
    if (file.size > maxSize) {
      return 'File size must be less than 4MB.';
    }

    return null;
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    // GUARD: Prevent multiple calls
    if (uploadingVoice || uploadedVoice) return;
    
    const file = event.target.files?.[0];
    if (!file) return;

    // CLEAR INPUT: Prevent re-triggers
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    const validationError = validateAudioFile(file);
    if (validationError) {
      setUploadError(validationError);
      return;
    }

    setUploadingVoice(true);
    setUploadError(null);

    try {
      // UPDATED: Use original filename for display, will be sanitized by backend
      const originalFileName = file.name.replace(/\.[^/.]+$/, '').slice(0, 20);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${timestamp}-${file.name}`;
      const filePath = `${userId}/clone_voices/${fileName}`;

      // Upload file to audio bucket
      const { error: uploadError } = await supabase.storage
        .from('audio')
        .upload(filePath, file, {
          contentType: file.type,
          upsert: true
        });

      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('audio')
        .getPublicUrl(filePath);

      if (!urlData?.publicUrl) {
        throw new Error('Failed to get public URL for uploaded file');
      }

      // Convert audio file to base64 for API call - FIXED VERSION
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binaryString = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binaryString += String.fromCharCode(uint8Array[i]);
      }
      const base64Audio = btoa(binaryString);

      // Call manage-clone-voice to create the voice
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('Authentication required');
      }

      const response = await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/manage-clone-voice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          action: 'create',
          voice_name: originalFileName, // Use original filename
          language: selectedCloneLanguage, // UPDATED: Use selected language instead of hardcoded 'english'
          audio_data: base64Audio
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create clone voice');
      }

      const result = await response.json();

      console.log('Clone voice creation result:', result);

      // UPDATED: Store the uploaded voice data with actual voice ID from Inworld
      const uploadedVoiceData: UploadedVoiceData = {
        file,
        voiceId: result.voiceId, // Use actual voice ID from Inworld
        displayName: result.voiceName, // Use original voice name for display
        filePath
      };

      setUploadedVoice(uploadedVoiceData);

      // UPDATED: Auto-select using actual voice ID
      onVoiceSelect(`clone:${result.voiceId}`);

      // Notify parent component about the created voice
      if (onCloneVoiceCreated) {
        onCloneVoiceCreated(result.voiceId, filePath);
      }

      // Show warnings if any
      if (result.warnings && result.warnings.length > 0) {
        console.warn('Clone voice creation warnings:', result.warnings);
      }

    } catch (error: any) {
      console.error('Error uploading clone voice:', error);
      setUploadError(error.message || 'Failed to upload and create clone voice');
      // Reset state on error
      setUploadedVoice(null);
    } finally {
      setUploadingVoice(false);
    }
  };

  // UPDATED: Handle uploaded file deletion
  const handleDeleteUploadedFile = async () => {
    if (!uploadedVoice) return;

    try {
      // If a clone voice was created, delete it
      if (uploadedVoice.voiceId) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          await fetch(`${import.meta.env.SUPABASE_URL}/functions/v1/manage-clone-voice`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              action: 'delete',
              voice_id: uploadedVoice.voiceId,
              audio_file_path: uploadedVoice.filePath
            }),
          });

          console.log(`Cleaned up uploaded clone voice: ${uploadedVoice.voiceId}`);

          // Clear selection if this voice was selected
          if (selectedVoice === `clone:${uploadedVoice.voiceId}`) {
            onVoiceSelect('');
          }
        }
      }

      // Clear upload section
      clearUploadSection();

    } catch (error: any) {
      console.error('Error deleting uploaded file:', error);
      setUploadError(error.message || 'Failed to delete uploaded file');
    }
  };

  const renderVoiceCard = (voice: any, voiceKey: string, type: string) => {
    // UPDATED: Calculate if this voice should be disabled based on uploaded file
    const isDisabledByUpload = uploadedVoice && voiceKey !== `clone:${uploadedVoice.voiceId}`;
    
    // NEW: Check if voice is restricted due to pause TTS
    const isRestrictedByPauses = pauseRestricted && type === 'core';
    
    const isDisabled = disabled || isDisabledByUpload || isRestrictedByPauses;

    return (
      <div
        key={voiceKey}
        className={`relative bg-surface-card rounded-xl p-4 cursor-pointer transition-all duration-200 ${
          selectedVoice === voiceKey ? 'ring-2 ring-accent' : isDisabled ? 'ring-2 ring-white/10' : 'hover:ring-2 hover:ring-white/20'
        } ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        onClick={() => {
          if (isDisabledByUpload || isRestrictedByPauses) return;
          onVoiceSelect(voiceKey);
        }}
      >
        <div className="flex items-center space-x-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            type === 'core' ? 'bg-gradient-to-br from-green-400 to-green-600' :
            type === 'premium' ? 'bg-gradient-to-br from-yellow-400 to-yellow-600' :
            type === 'apex' ? 'bg-gradient-to-br from-orange-400 to-orange-600' :
            type === 'clone' ? 'bg-gradient-to-br from-purple-400 to-purple-600' :
            'bg-white/10'
          }`}>
            {type === 'premium' || type === 'apex' ? (
              <span className="text-xl">{voice.flag}</span>
            ) : type === 'clone' ? (
              <User className="h-5 w-5 text-white" />
            ) : (
              <User className="h-5 w-5 text-white" />
            )}
          </div>
          <div className="flex-1">
            <h3 className="text-white font-medium">
              {type === 'apex' ? formatVoiceName(voice.name) : voice.name}
            </h3>
            <p className="text-text-muted text-sm capitalize">
              {type} • {voice.language} • {
                type === 'core' ? '2' :
                type === 'premium' || type === 'clone' ? '4' : '8'
              } tokens/char
            </p>
          </div>
          <div className="flex items-center space-x-2">
            {voiceSamples[voiceKey] && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // CHANGED: Allow playing for all users, only disable for upload
                  if (!isDisabledByUpload) handlePlaySample(voiceKey);
                }}
                className="flex items-center px-2 py-1 bg-white/10 text-white rounded-xl hover:bg-white/15 text-sm"
                disabled={isDisabledByUpload}
              >
                {currentlyPlaying === voiceKey ? <Pause className="h-3 w-3 mr-1" /> : <Play className="h-3 w-3 mr-1" />}
                {currentlyPlaying === voiceKey ? 'Stop' : 'Play'}
              </button>
            )}
          </div>
        </div>
        {selectedVoice === voiceKey && (
          <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
            <CheckCircle2 className="h-4 w-4" />
          </div>
        )}
        {isDisabledByUpload && (
          <div className="absolute inset-0 bg-black/70 rounded-xl flex items-center justify-center">
            <span className="text-text-secondary text-sm font-medium">Upload in progress</span>
          </div>
        )}
        {/* Pause restriction overlay for Core voices */}
        {isRestrictedByPauses && (
          <div className="absolute inset-0 bg-black/60 rounded-xl flex items-center justify-center">
            <div className="flex items-center space-x-1.5 bg-yellow-500/90 text-black rounded px-2.5 py-1 text-xs font-medium">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>Incompatible with Pauses</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  // UPDATED: Render uploaded voice card in upload section
  const renderUploadedVoiceCard = () => {
    if (!uploadedVoice) return null;

    const voiceKey = `clone:${uploadedVoice.voiceId}`;
    const isSelected = selectedVoice === voiceKey;

    return (
      <div
        className={`relative bg-surface-card rounded-xl p-4 cursor-pointer transition-all duration-200 ${
          isSelected ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-white/20'
        } ${uploadingVoice ? 'opacity-75' : ''}`}
        onClick={() => !uploadingVoice && onVoiceSelect(voiceKey)}
      >
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-br from-purple-400 to-purple-600">
            <User className="h-5 w-5 text-white" />
          </div>
          <div className="flex-1">
            <h3 className="text-white font-medium capitalize">{uploadedVoice.displayName}</h3>
            <p className="text-text-muted text-sm">
              {uploadingVoice ? 'Creating...' : 'Custom Clone • 4 tokens/char'}
            </p>
          </div>
          <div className="flex items-center space-x-2">
            {uploadingVoice && (
              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-purple-400"></div>
            )}
          </div>
        </div>
        {isSelected && !uploadingVoice && (
          <div className="absolute top-2 right-2 bg-accent text-white rounded-full p-1">
            <CheckCircle2 className="h-4 w-4" />
          </div>
        )}
      </div>
    );
  };

  const renderLanguageFilter = (
    languages: { code: string; name: string; flag: string }[],
    selectedLanguage: string,
    onLanguageChange: (language: string) => void,
    type: 'premium' | 'apex'
  ) => {
    const selectedLang = languages.find(l => l.code === selectedLanguage);
    return (
      <div className="flex items-center space-x-2">
        <span className="text-sm text-text-secondary">Language:</span>
        <Listbox value={selectedLanguage} onChange={onLanguageChange}>
          {({ open }) => (
            <div className="relative">
              <Listbox.Button className={`relative ${
                type === 'premium' ? 'bg-yellow-800/30 border-yellow-500' : 'bg-orange-800/30 border-orange-500'
              } border rounded-md px-3 py-1.5 pr-8 text-left text-white focus:outline-none focus:ring-2 ${
                type === 'premium' ? 'focus:ring-yellow-500' : 'focus:ring-orange-500'
              } text-sm min-w-[180px] cursor-pointer`}>
                <span className="block truncate flex items-center">
                  <span className="mr-2">{selectedLang?.flag}</span>
                  {selectedLang?.name}
                </span>
                <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                  <ChevronDown className={`h-4 w-4 ${
                    type === 'premium' ? 'text-yellow-400' : 'text-orange-400'
                  } transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                </span>
              </Listbox.Button>

              <Transition
                show={open}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Listbox.Options className={`absolute z-10 mt-1 w-full ${
                  type === 'premium' ? 'bg-yellow-800 border-yellow-600' : 'bg-orange-800 border-orange-600'
                } border rounded-md shadow-lg max-h-60 overflow-auto focus:outline-none`}>
                  {languages.map((language) => (
                    <Listbox.Option
                      key={language.code}
                      value={language.code}
                      className={({ active, selected }) =>
                        `relative cursor-pointer select-none py-2 pl-4 pr-10 ${
                          active 
                            ? type === 'premium' ? 'bg-yellow-700 text-white' : 'bg-orange-700 text-white'
                            : type === 'premium' ? 'text-yellow-200' : 'text-orange-200'
                        } ${selected ? 'font-medium' : 'font-normal'}`
                      }
                    >
                      {({ selected }) => (
                        <>
                          <span className={`flex items-center ${selected ? 'font-medium' : 'font-normal'}`}>
                            <span className="mr-2">{language.flag}</span>
                            {language.name}
                          </span>
                          {selected && (
                            <span className={`absolute inset-y-0 right-0 flex items-center pr-3 ${
                              type === 'premium' ? 'text-yellow-400' : 'text-orange-400'
                            }`}>
                              <CheckCircle2 className="h-4 w-4" />
                            </span>
                          )}
                        </>
                      )}
                    </Listbox.Option>
                  ))}
                </Listbox.Options>
              </Transition>
            </div>
          )}
        </Listbox>
      </div>
    );
  };

  // ADDED: Render clone language filter
  const renderCloneLanguageFilter = () => (
    <div className="flex items-center space-x-2">
      <span className="text-sm text-text-secondary">Language:</span>
      <Listbox value={selectedCloneLanguage} onChange={setSelectedCloneLanguage}>
        {({ open }) => (
          <div className="relative">
            <Listbox.Button className="relative bg-purple-800/30 border-purple-500 border rounded-md px-3 py-1.5 pr-8 text-left text-white focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm min-w-[180px] cursor-pointer">
              <span className="block truncate flex items-center">
                <span className="mr-2">
                  {cloneLanguages.find(lang => lang.code === selectedCloneLanguage)?.flag}
                </span>
                {cloneLanguages.find(lang => lang.code === selectedCloneLanguage)?.name}
              </span>
              <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                <ChevronDown className={`h-4 w-4 text-purple-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
              </span>
            </Listbox.Button>

            <Transition
              show={open}
              enter="transition ease-out duration-100"
              enterFrom="transform opacity-0 scale-95"
              enterTo="transform opacity-100 scale-100"
              leave="transition ease-in duration-75"
              leaveFrom="transform opacity-100 scale-100"
              leaveTo="transform opacity-0 scale-95"
            >
              <Listbox.Options className="absolute z-10 mt-1 w-full bg-purple-800 border-purple-600 border rounded-md shadow-lg max-h-60 overflow-auto focus:outline-none">
                {cloneLanguages.map((language) => (
                  <Listbox.Option
                    key={language.code}
                    value={language.code}
                    className={({ active, selected }) =>
                      `relative cursor-pointer select-none py-2 pl-4 pr-10 ${
                        active ? 'bg-purple-700 text-white' : 'text-purple-200'
                      } ${selected ? 'font-medium' : 'font-normal'}`
                    }
                  >
                    {({ selected }) => (
                      <>
                        <span className={`flex items-center ${selected ? 'font-medium' : 'font-normal'}`}>
                          <span className="mr-2">{language.flag}</span>
                          {language.name}
                        </span>
                        {selected && (
                          <span className="absolute inset-y-0 right-0 flex items-center pr-3 text-purple-400">
                            <CheckCircle2 className="h-4 w-4" />
                          </span>
                        )}
                      </>
                    )}
                  </Listbox.Option>
                ))}
              </Listbox.Options>
            </Transition>
          </div>
        )}
      </Listbox>
    </div>
  );

  const renderShowMoreButton = (
    currentCount: number,
    totalCount: number,
    showMore: boolean,
    onToggle: () => void
  ) => (
    totalCount > 6 && (
      <div className="flex justify-center">
        <button
          onClick={onToggle}
          className="flex items-center px-4 py-2 bg-surface-input text-white rounded-xl hover:bg-white/15 transition-colors"
          disabled={disabled || uploadedVoice !== null}
        >
          <ChevronDown className={`h-4 w-4 mr-2 transition-transform duration-200 ${showMore ? 'rotate-180' : ''}`} />
          {showMore ? 'Show Less' : 'Show More'}
        </button>
      </div>
    )
  );

  // Tier config for accordion rendering
  const tierConfig = [
    {
      id: 'core',
      label: 'Core',
      color: 'emerald',
      textColor: 'text-emerald-400',
      voiceCount: coreVoices.length,
      tokensPerChar: 2,
      bgGradient: 'from-emerald-950/70 to-emerald-900/20',
      borderColor: 'border-emerald-800/25',
      headerBorder: 'border-emerald-800/40',
      headerHover: 'hover:bg-emerald-950/40',
      dotColor: 'bg-emerald-400',
    },
    {
      id: 'premium',
      label: 'Premium',
      color: 'yellow',
      textColor: 'text-yellow-400',
      voiceCount: premiumVoices.length,
      tokensPerChar: 4,
      bgGradient: 'from-yellow-950/70 to-yellow-900/20',
      borderColor: 'border-yellow-800/25',
      headerBorder: 'border-yellow-800/40',
      headerHover: 'hover:bg-yellow-950/40',
      dotColor: 'bg-yellow-400',
    },
    {
      id: 'clone',
      label: 'Clone',
      color: 'purple',
      textColor: 'text-purple-400',
      voiceCount: predefinedCloneVoices.length,
      tokensPerChar: 4,
      bgGradient: 'from-purple-950/70 to-purple-900/20',
      borderColor: 'border-purple-800/25',
      headerBorder: 'border-purple-800/40',
      headerHover: 'hover:bg-purple-950/40',
      dotColor: 'bg-purple-400',
    },
    {
      id: 'apex',
      label: 'Apex',
      color: 'orange',
      textColor: 'text-orange-400',
      voiceCount: apexVoices.length,
      tokensPerChar: 8,
      bgGradient: 'from-orange-950/70 to-orange-900/20',
      borderColor: 'border-orange-800/25',
      headerBorder: 'border-orange-800/40',
      headerHover: 'hover:bg-orange-950/40',
      dotColor: 'bg-orange-400',
    },
    {
      id: 'elevenlabs',
      label: 'ElevenLabs',
      color: 'white',
      textColor: 'text-zinc-200',
      voiceCount: '5,000+' as unknown as number,
      tokensPerChar: '100–200' as unknown as number,
      bgGradient: 'from-zinc-950 via-black to-zinc-900',
      borderColor: 'border-white/10',
      headerBorder: 'border-white/15',
      headerHover: 'hover:bg-white/[0.04]',
      dotColor: 'bg-white',
    },
  ].filter((tier) => !(hideElevenLabs && tier.id === 'elevenlabs'));

  // Check if a voice from a specific tier is currently selected
  const getSelectedVoiceForTier = (tierId: string): string | null => {
    if (tierId === 'elevenlabs') {
      return selectedVoice.startsWith('elevenlabs:') ? (elevenLabsSelectedLabel ?? 'Selected') : null;
    }
    if (selectedVoice.startsWith(`${tierId}:`)) {
      return getVoiceDisplayName(selectedVoice);
    }
    return null;
  };

  return (
    <div className="space-y-3">
      {tierConfig.map((tier) => {
        const isExpanded = expandedTier === tier.id;
        const selectedInTier = getSelectedVoiceForTier(tier.id);

        return (
          <div key={tier.id} className={`rounded-2xl border transition-colors duration-200 ${tier.borderColor} ${isExpanded ? `bg-gradient-to-br ${tier.bgGradient}` : 'bg-surface-card/30'}`}>
            {/* Accordion Header */}
            <button
              type="button"
              onClick={() => toggleTier(tier.id)}
              className={`w-full flex items-center justify-between px-5 py-4 rounded-2xl transition-colors duration-200 ${tier.headerHover} group`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-2.5 h-2.5 rounded-full ${tier.dotColor}`} />
                <span className={`text-[10px] font-mono tracking-[0.15em] uppercase ${tier.textColor}`}>
                  {tier.label}
                </span>
                <span className="text-text-muted text-xs">
                  {tier.voiceCount} voices · {tier.tokensPerChar} tokens/char
                </span>
                {isFreeUser && (
                  <span className="text-yellow-400 text-xs">(Paid plan required)</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {selectedInTier && !isExpanded && (
                  <span className="flex items-center gap-1.5 text-xs text-white/70 bg-white/10 px-2.5 py-1 rounded-lg">
                    <CheckCircle2 className="h-3 w-3 text-accent" />
                    {selectedInTier}
                  </span>
                )}
                <ChevronDown className={`h-4 w-4 text-text-muted transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} />
              </div>
            </button>

            {/* Accordion Content */}
            <div
              style={{
                display: 'grid',
                gridTemplateRows: isExpanded ? '1fr' : '0fr',
                transition: 'grid-template-rows 0.3s ease-out',
              }}
            >
              <div style={{ overflow: 'hidden' }}>
                <div className="px-5 pb-5">
                  {/* === CORE TIER CONTENT === */}
                  {tier.id === 'core' && (
                    <>
                      <p className="text-text-secondary text-sm mb-4">
                        Budget-friendly English voices. All Core Voices are English only.
                      </p>
                      {pauseRestricted && (
                        <div className="flex items-start space-x-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-4">
                          <AlertTriangle className="h-5 w-5 text-yellow-400 flex-shrink-0 mt-0.5" />
                          <p className="text-yellow-300 text-sm">
                            Core voices do not support text-to-speech pauses. Please select a Premium, Apex, or Clone voice for pause functionality.
                          </p>
                        </div>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                        {displayedCoreVoices.map((voice) => 
                          renderVoiceCard(voice, `core:${voice.name}`, 'core')
                        )}
                      </div>
                      {renderShowMoreButton(
                        displayedCoreVoices.length,
                        coreVoices.length,
                        showMoreCoreVoices,
                        () => setShowMoreCoreVoices(!showMoreCoreVoices)
                      )}
                    </>
                  )}

                  {/* === PREMIUM TIER CONTENT === */}
                  {tier.id === 'premium' && (
                    <>
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-text-secondary text-sm">
                          Ultra-realistic narration with multiple languages.
                        </p>
                        {renderLanguageFilter(premiumLanguages, selectedPremiumLanguage, setSelectedPremiumLanguage, 'premium')}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                        {displayedPremiumVoices.map((voice) => 
                          renderVoiceCard(voice, `premium:${voice.name}`, 'premium')
                        )}
                      </div>
                      {renderShowMoreButton(
                        displayedPremiumVoices.length,
                        getFilteredPremiumVoices().length,
                        showMorePremiumVoices,
                        () => setShowMorePremiumVoices(!showMorePremiumVoices)
                      )}
                    </>
                  )}

                  {/* === CLONE TIER CONTENT === */}
                  {tier.id === 'clone' && (
                    <>
                      <p className="text-text-secondary text-sm mt-2 mb-4">
                        Clone your own voice or use our predefined voices.
                      </p>

                      {/* Upload Section */}
                      <div className="mb-6">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-lg font-medium text-white">Upload Your Voice</h3>
                          {isPaidUser && !disabled && !uploadingVoice && !uploadedVoice && renderCloneLanguageFilter()}
                        </div>
                        
                        {!uploadedVoice ? (
                          <div className="flex items-center justify-center w-full">
                            <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-purple-600 border-dashed rounded-xl ${
                              isPaidUser && !disabled && !uploadingVoice 
                                ? 'cursor-pointer bg-purple-900/20 hover:bg-purple-800/30' 
                                : 'cursor-not-allowed bg-black/20'
                            } transition-colors ${
                              disabled || uploadingVoice || isFreeUser ? 'opacity-50' : ''
                            }`}>
                              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                {uploadingVoice ? (
                                  <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-purple-500 mb-3"></div>
                                ) : isFreeUser ? (
                                  <Lock className="w-8 h-8 mb-3 text-text-muted" />
                                ) : (
                                  <Upload className="w-8 h-8 mb-3 text-purple-400" />
                                )}
                                <p className="mb-2 text-sm text-purple-300">
                                  <span className="font-semibold">
                                    {uploadingVoice 
                                      ? 'Creating clone voice...' 
                                      : isFreeUser 
                                      ? 'Voice cloning requires a paid plan'
                                      : 'Click to upload your voice'
                                    }
                                  </span>
                                </p>
                                <p className="text-xs text-purple-400">
                                  {isFreeUser 
                                    ? 'Upgrade to upload custom voices'
                                    : 'MP3, WAV, or M4A (max 4MB, 10sec-5min)'
                                  }
                                </p>
                              </div>
                              <input
                                ref={fileInputRef}
                                type="file"
                                className="hidden"
                                accept=".mp3,.wav,.m4a,audio/mp3,audio/wav,audio/m4a"
                                onChange={handleFileUpload}
                                disabled={disabled || uploadingVoice || uploadedVoice !== null || isFreeUser}
                              />
                            </label>
                          </div>
                        ) : (
                          <div className="space-y-4">
                            <div className="bg-surface-card/50 rounded-xl p-4">
                              <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center space-x-3">
                                  <FileAudio className="h-5 w-5 text-purple-400" />
                                  <div>
                                    <p className="text-white font-medium">{uploadedVoice.file.name}</p>
                                    <p className="text-text-muted text-sm">{formatFileSize(uploadedVoice.file.size)}</p>
                                  </div>
                                </div>
                                <button
                                  onClick={handleDeleteUploadedFile}
                                  className="flex items-center px-3 py-1.5 bg-accent text-white rounded-xl hover:bg-accent-hover text-sm"
                                  disabled={uploadingVoice}
                                >
                                  <Trash2 className="h-4 w-4 mr-1" />
                                  Delete
                                </button>
                              </div>
                              {uploadingVoice && (
                                <div className="text-sm text-purple-300">
                                  Creating clone voice...
                                </div>
                              )}
                            </div>

                            {!uploadingVoice && (
                              <div>
                                <h4 className="text-md font-medium text-white mb-2">Select Your Uploaded Voice</h4>
                                {renderUploadedVoiceCard()}
                              </div>
                            )}
                          </div>
                        )}

                        {uploadError && (
                          <div className="mt-2 flex items-center text-red-400 text-sm">
                            <AlertCircle className="h-4 w-4 mr-2" />
                            {uploadError}
                            <button
                              onClick={() => setUploadError(null)}
                              className="ml-2 text-text-muted hover:text-white"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        )}

                        <div className="mt-4 p-3 bg-white/5 rounded-xl border border-border-card">
                          <div className="flex items-start space-x-2">
                            <Info className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />
                            <div className="text-sm text-text-secondary">
                              <p className="mb-2">
                                By using voice cloning, you certify that you have all legal consents/rights to clone these voice samples and that you will not use anything generated for illegal or harmful purposes.
                              </p>
                              <p>
                                The service is governed by our{' '}
                                <a href="/terms" className="text-accent hover:text-accent-hover underline">
                                  Terms of Service
                                </a>
                                {' '}and{' '}
                                <a href="/privacy" className="text-accent hover:text-accent-hover underline">
                                  Privacy Policy
                                </a>
                                .
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Predefined Clone Voices Grid */}
                      <div>
                        <h3 className="text-[10px] font-mono tracking-[0.15em] text-purple-300 uppercase mb-4">Predefined Clone Voices</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                          {displayedCloneVoices.map((voice) => 
                            renderVoiceCard(voice, `clone:${voice.name}`, 'clone')
                          )}
                        </div>
                        {renderShowMoreButton(
                          displayedCloneVoices.length,
                          predefinedCloneVoices.length,
                          showMoreCloneVoices,
                          () => setShowMoreCloneVoices(!showMoreCloneVoices)
                        )}
                      </div>
                    </>
                  )}

                  {/* === APEX TIER CONTENT === */}
                  {tier.id === 'apex' && (
                    <>
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-text-secondary text-sm">
                          Highest-quality voices with the widest language selection.
                        </p>
                        {renderLanguageFilter(apexLanguages, selectedApexLanguage, setSelectedApexLanguage, 'apex')}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                        {displayedApexVoices.map((voice) => 
                          renderVoiceCard(voice, `apex:${voice.name}`, 'apex')
                        )}
                      </div>
                      {renderShowMoreButton(
                        displayedApexVoices.length,
                        getFilteredApexVoices().length,
                        showMoreApexVoices,
                        () => setShowMoreApexVoices(!showMoreApexVoices)
                      )}
                    </>
                  )}

                  {/* === ELEVENLABS TIER CONTENT === */}
                  {tier.id === 'elevenlabs' && (
                    <>
                      <p className="text-text-secondary text-sm mb-4">
                        5,000+ voices from the ElevenLabs library. Higher cost (100–200 tokens/char) and a wider language and style range than Apex.
                      </p>
                      {onSelectElevenLabsVoice && (
                        <ElevenLabsVoiceBrowser
                          embedded
                          currentSelectedVoiceId={selectedVoice.startsWith('elevenlabs:') ? elevenLabsCurrentVoiceId : undefined}
                          initialModelId={elevenLabsModelId}
                          onSelectVoice={onSelectElevenLabsVoice}
                          onModelChange={onElevenLabsModelChange}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

VoiceSelector.displayName = 'VoiceSelector';

export default VoiceSelector;


