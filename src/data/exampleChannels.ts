export interface ExampleChannel {
  name: string;
  url: string;
  subscribers: string;
  thumbnail: string;
  mvm: string;
  mem: string;
}

const parseEarnings = (earnings: string): number => {
  const cleaned = earnings.replace(/[$,]/g, '').trim();
  const hasK = /k$/i.test(cleaned);
  const hasM = /m$/i.test(cleaned);
  const num = parseFloat(cleaned.replace(/[kmKM]$/, ''));
  if (Number.isNaN(num)) return 0;
  if (hasM) return num * 1_000_000;
  if (hasK) return num * 1_000;
  return num;
};

export const exampleChannels: ExampleChannel[] = [
  {
    name: "Let's Read Podcast",
    url: "https://www.youtube.com/@LetsReadPodcast",
    subscribers: "1.33M",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/LetsRead.jpg",
    mvm: "6 million",
    mem: "$39k"
  },
  {
    name: "Darkness Prevails",
    url: "https://www.youtube.com/@DarknessPrevails",
    subscribers: "810k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/DarknessPrevails.jpg",
    mvm: "2.7 million",
    mem: "$17k"
  },
  {
    name: "Wartime Stories",
    url: "https://www.youtube.com/@WartimeStories",
    subscribers: "800k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/WartimeStories.jpg",
    mvm: "3.3 million",
    mem: "$25k"
  },
  {
    name: "Sleepless Historian",
    url: "https://www.youtube.com/@SleeplessHistorian",
    subscribers: "678k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/SleeplessHistorian.jpg",
    mvm: "11.5 million",
    mem: "$211k"
  },
  {
    name: "Koala Moon",
    url: "https://www.youtube.com/@koalamoonfm",
    subscribers: "156k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/KoalaMoon.jpg",
    mvm: "4.2 million",
    mem: "$25k"
  },
  {
    name: "Native African Tales",
    url: "https://www.youtube.com/@NativeAfricanTales",
    subscribers: "154k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/NativeAfricanTales.jpg",
    mvm: "1.1 million",
    mem: "$6k"
  },
  {
    name: "Starbound HFY",
    url: "https://www.youtube.com/@StarboundHFY/videos",
    subscribers: "150k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/StarboundHFY.jpg",
    mvm: "2 million",
    mem: "$14k"
  },
  {
    name: "Truth By Philosophers",
    url: "https://www.youtube.com/@TruthByPhilosophers/videos",
    subscribers: "99k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/Truth.jpg",
    mvm: "2 million",
    mem: "$63k"
  },
  {
    name: "The Dreamoria",
    url: "https://www.youtube.com/@TheDreamoria/videos",
    subscribers: "54k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/Dreamoria.jpg",
    mvm: "968k",
    mem: "$18k"
  },
  {
    name: "Just About Earth",
    url: "https://www.youtube.com/@justaboutearth",
    subscribers: "50k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/JustAboutEarth.jpg",
    mvm: "1.6 million",
    mem: "$31k"
  },
  {
    name: "Stories Of The Imperium",
    url: "https://www.youtube.com/@StoriesOfTheImperium",
    subscribers: "49k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/StoriesOfTheImperium.jpg",
    mvm: "1.6 million",
    mem: "$29k"
  },
  {
    name: "The Boring Historian",
    url: "https://www.youtube.com/@TheBoring.Historian/videos",
    subscribers: "35k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/TheBoringHistorian.jpg",
    mvm: "888k",
    mem: "$6k"
  },
  {
    name: "Dust and Glory",
    url: "https://www.youtube.com/@DustandGloryYT",
    subscribers: "33k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/DustandGlory.jpg",
    mvm: "803k",
    mem: "$4k"
  },
  {
    name: "HFY Zenith",
    url: "https://www.youtube.com/@HFYZenith",
    subscribers: "31k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/HFYZenith.jpg",
    mvm: "2.1 million",
    mem: "$15k"
  },
  {
    name: "Blundera",
    url: "https://www.youtube.com/@Blundera33/videos",
    subscribers: "28k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/Blundera.jpg",
    mvm: "1.5 million",
    mem: "$30k"
  },
  {
    name: "Comfy History",
    url: "https://www.youtube.com/@ComfyHistory101",
    subscribers: "19k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/ComfyHistory.jpg",
    mvm: "755k",
    mem: "$28k"
  },
  {
    name: "Dinodust",
    url: "https://www.youtube.com/@DinodustDOC",
    subscribers: "12k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/Dinodust.jpg",
    mvm: "888k",
    mem: "$14k"
  },
  {
    name: "The Midnight Reader",
    url: "https://www.youtube.com/@TheMidnightReaderYT/videos",
    subscribers: "8k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/TheMidnightReader.jpg",
    mvm: "84k",
    mem: "$332"
  },
  {
    name: "Bible Chronicles Animation",
    url: "https://www.youtube.com/channel/UCwctsAkgR1Z74Dd-Y0aszZg",
    subscribers: "436k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/BibleChroniclesAnimation.jpg",
    mvm: "816k",
    mem: "$3k"
  },
  {
    name: "NatGeo Pocket",
    url: "https://www.youtube.com/@NatGeoPocket",
    subscribers: "21k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/NatGeoPocket.jpg",
    mvm: "320k",
    mem: "$1k"
  },
  {
    name: "SAGE Stories",
    url: "https://www.youtube.com/@SAGEstories3",
    subscribers: "34k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/SAGEStories.jpg",
    mvm: "473k",
    mem: "$2k"
  },
  {
    name: "Mr Book and Me Stories",
    url: "https://www.youtube.com/@MrBookandMeStories",
    subscribers: "49k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/MrBookAndMeStories.jpg",
    mvm: "566k",
    mem: "$2k"
  },
  {
    name: "Ark Films Channel",
    url: "https://www.youtube.com/@ArkFilmsChannel",
    subscribers: "79k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/ArkFilmsChannel.jpg",
    mvm: "1.5 million",
    mem: "$6k"
  },
  {
    name: "Buried Truths Stories",
    url: "https://www.youtube.com/@BuriedTruthsStories",
    subscribers: "20k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/BuriedTruthsStories.jpg",
    mvm: "144k",
    mem: "$592"
  },
  {
    name: "Fairy Tales and Stories for Kids",
    url: "https://www.youtube.com/@FairyTales.English",
    subscribers: "2.96M",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/FairyTalesAndStoriesForKids.jpg",
    mvm: "11 million",
    mem: "$45k"
  },
  {
    name: "STORY ADDICTION",
    url: "https://www.youtube.com/@StoryAddictionOfficial",
    subscribers: "65k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/STORYADDICTION.jpg",
    mvm: "1.9 million",
    mem: "$8k"
  },
  {
    name: "Boring History",
    url: "https://www.youtube.com/@Boringhistorysleeper",
    subscribers: "133k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/BoringHistory.jpg",
    mvm: "400k",
    mem: "$2k"
  },
  {
    name: "Zgapariko English",
    url: "https://www.youtube.com/@zgaparikoeng",
    subscribers: "33k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/ZgaparikoEnglish.jpg",
    mvm: "983k",
    mem: "$4k"
  },
  {
    name: "English Daily Live",
    url: "https://www.youtube.com/@EnglishDailyLive",
    subscribers: "27k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/EnglishDailyLive.jpg",
    mvm: "2.9 million",
    mem: "$12k"
  },
  {
    name: "Weepy Emotional stories",
    url: "https://www.youtube.com/channel/UCYUMGZouMgRmhhWYqz-2aOA",
    subscribers: "13k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/WeepyEmotionalStories.jpg",
    mvm: "572k",
    mem: "$2k"
  },
  {
    name: "Hominid History Hub",
    url: "https://www.youtube.com/@HominidHistoryHub",
    subscribers: "412k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/HominidHistoryHub.jpg",
    mvm: "6.5 million",
    mem: "$27k"
  },
  {
    name: "Majestic Studios",
    url: "https://www.youtube.com/@MajesticAIStudio",
    subscribers: "196k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/MajesticStudios.jpg",
    mvm: "1.8 million",
    mem: "$7k"
  },
  {
    name: "Sleepy Time History",
    url: "https://www.youtube.com/@SleepyTimeHistoryYT",
    subscribers: "144k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/SleepyTimeHistory.jpg",
    mvm: "2 million",
    mem: "$8k"
  },
  {
    name: "Bible Origins",
    url: "https://www.youtube.com/@BibleOrigins1",
    subscribers: "148k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/BibleOrigins.jpg",
    mvm: "2.7 million",
    mem: "$11k"
  },
  {
    name: "Wild Horizons",
    url: "https://www.youtube.com/@WildHorizons6688",
    subscribers: "39k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/WildHorizons.jpg",
    mvm: "3.1 million",
    mem: "$13k"
  },
  {
    name: "Zenith Zen",
    url: "https://www.youtube.com/@zenithzen001",
    subscribers: "10k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/ZenithZen.jpg",
    mvm: "1.8 million",
    mem: "$7k"
  },
  {
    name: "I Got a Pet Monster",
    url: "https://www.youtube.com/@i-got-a-pet-monster",
    subscribers: "8k",
    thumbnail: "https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ExampleChannels/IGotAPetMonster.jpg",
    mvm: "264k",
    mem: "$1k"
  }
].sort((a, b) => parseEarnings(b.mem) - parseEarnings(a.mem));



