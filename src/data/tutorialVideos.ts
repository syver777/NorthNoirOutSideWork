export interface TutorialVideo {
  id: string;
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl: string;
  thumbnailAlt: string;
}

const THUMBNAIL_URL = 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/ThumbnailTest.jpg';

export const tutorialVideos: TutorialVideo[] = [
  {
    id: 'north-noir',
    title: 'How to Use North Noir',
    description: 'Watch this full video to see how to use North Noir and discover why it\'s the ultimate tool for creating long-form YouTube content.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20North%20Noir.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir tutorial video thumbnail',
  },
  {
    id: 'video-generator',
    title: 'How to Use the Video Generator',
    description: 'Learn how the Video Generator combines all individual features to create complete videos up to 20 hours long, streamlining your entire YouTube production process.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Video%20Generator.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir video generator tutorial thumbnail',
  },
  {
    id: 'story-generator',
    title: 'How to Use the Story Generator',
    description: 'Learn how to use the Story Generator to craft compelling scripts and narratives for your YouTube videos.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Story%20Generator.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir story generator tutorial thumbnail',
  },
  {
    id: 'text-to-speech',
    title: 'How to Use the Text-To-Speech',
    description: 'This video explains how and why to use the Text-To-Speech feature to enhance your YouTube video production.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Text-To-Speech.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir text-to-speech tutorial thumbnail',
  },
  {
    id: 'image-generator',
    title: 'How to Use the Image Generator',
    description: 'Watch this video to learn how to use the Image Generator and how it integrates with other North Noir features.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Image%20Generator.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir image generator tutorial thumbnail',
  },
  {
    id: 'text-to-video',
    title: 'How to Use the Text-To-Video Generator',
    description: 'Learn how the Text-To-Video Generator converts your story into a full series of AI-generated video clips, ready to combine into a complete YouTube video.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Text-To-Video%20Generator.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir text-to-video generator tutorial thumbnail',
  },
  {
    id: 'image-to-video',
    title: 'How to Use the Image-To-Video Generator',
    description: 'Learn how the Image-To-Video Generator takes your story through a 4-phase pipeline — generating image prompts, keyframe images, video prompts, and final video clips.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Image-To-Video%20Generator.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir image-to-video generator tutorial thumbnail',
  },
  {
    id: 'image-prompt-generator',
    title: 'How to Use the Image Prompt Generator',
    description: 'Learn how to use the Image Prompt Generator to create detailed, optimized prompts for generating consistent visuals for your videos.',
    videoUrl: 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/How%20to%20use%20the%20Image%20Prompt%20Generator.mp4',
    thumbnailUrl: THUMBNAIL_URL,
    thumbnailAlt: 'North Noir image prompt generator tutorial thumbnail',
  },
];
