// Voice type detection functions and voice data

// Voice type detection helpers
export const isCoreVoice = (voice: string): boolean => {
  if (voice.includes(':')) {
    const [type] = voice.split(':');
    return type === 'core';
  }
  return false;
};

export const isPremiumVoice = (voice: string): boolean => {
  if (voice.includes(':')) {
    const [type] = voice.split(':');
    return type === 'premium';
  }
  return false;
};

export const isApexVoice = (voice: string): boolean => {
  if (voice.includes(':')) {
    const [type] = voice.split(':');
    return type === 'apex';
  }
  return false;
};

export const isCloneVoice = (voice: string): boolean => {
  if (voice.includes(':')) {
    const [type] = voice.split(':');
    return type === 'clone';
  }
  return false;
};

export const isElevenLabsVoice = (voice: string): boolean => {
  if (voice.includes(':')) {
    const [type] = voice.split(':');
    return type === 'elevenlabs';
  }
  return false;
};

// Predefined clone voices list (matching backend)
export const predefinedCloneVoices = [
  { name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan" },
  { name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian" },
  { name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred" },
  { name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad" },
  { name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo" },
  { name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder" },
  { name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor" }
];

// Helper function to format language for URL
export const formatLanguageForUrl = (language: string): string => {
  return language.toLowerCase().replace(/ /g, '-');
};

// Core voices data
export const coreVoices = [
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

export const coreVoiceSamples: Record<string, string> = coreVoices.reduce((acc, v) => {
  acc[`core:${v.name}`] = `https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/${v.name}_example.wav`;
  return acc;
}, {} as Record<string, string>);

// Premium voices data with flags
export const premiumVoices = [
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
  { name: "Dominus", type: "premium", language: "mandarin chinese", flag: "🇨🇳" },
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
  { name: "Rafael", type: "premium", language: "spanish", flag: "🇪🇸" }
];

export const premiumVoiceSamples: Record<string, string> = premiumVoices.reduce((acc, v) => {
  acc[`premium:${v.name}`] = `https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/${v.name}_example.wav`;
  return acc;
}, {} as Record<string, string>);

// Apex voices - large array exported for filtering
export const apexVoices = [
  // American English voices
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
  // British English voices
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
  // Australian English voices
  { name: "linda", type: "apex", language: "australian english", flag: "🇦🇺" },
  { name: "kim", type: "apex", language: "australian english", flag: "🇦🇺" },
  // Mexican Spanish voices
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
  // German voices
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
  // French voices
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

export const apexVoiceSamples: Record<string, string> = apexVoices.reduce((acc, v) => {
  const languageKey = formatLanguageForUrl(v.language);
  acc[`apex:${v.name}`] = `https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/apex-voices/${languageKey}/${v.name}_example.wav`;
  return acc;
}, {} as Record<string, string>);
