import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Mail, BookOpen, GitCompare, Image, Video, Mic, Clock, AlertCircle, HelpCircle, Play, DollarSign, Settings, ChevronDown } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import VideoPlayer from '../components/VideoPlayer';
import { tutorialVideos } from '../data/tutorialVideos';

const faqs = [
  {
    question: 'What makes North Noir different from other AI video tools?',
    answer: 'Most AI tools cap out at short clips or single scenes. North Noir generates complete video packages — script, images, and narration — for content up to 20 hours long. You get a ready-to-upload YouTube video from a single prompt.',
  },
  {
    question: 'How do I create my first video?',
    answer: 'Enter your video concept, adjust settings (length, style, voice), and hit generate. North Noir handles the rest: writing the script, creating visuals, and producing narration. The full workflow guide is on our homepage.',
  },
  {
    question: 'How much does it cost vs. hiring a team?',
    answer: 'Traditional production — writers, voiceover artists, image creators — can run thousands per video. North Noir delivers comparable results starting from $10/month, saving 90%+ on production costs.',
  },
  {
    question: 'How do I find profitable long-form niches?',
    answer: 'For personalized niche guidance, visit facelessyoutubeempire.com to schedule a strategy call. They specialize in helping creators discover high-performing niches for long-form content.',
    hasExternalLink: true,
  },
  {
    question: 'Why does YouTube favor long-form content?',
    answer: 'YouTube\'s algorithm groups content by length. Longer videos keep viewers on-platform, which YouTube rewards with better recommendations. Niches like storytelling, history, and tutorials see significant gains from extended content.',
  },
  {
    question: 'How does the generation pipeline work?',
    answer: 'Three stages: (1) AI generates a structured script with chapters and scenes, (2) image prompts are created and converted into consistent visuals, (3) text-to-speech narration is produced. Everything syncs automatically.',
  },
  {
    question: 'How long does generation take?',
    answer: 'It depends on length. A 1-hour video typically takes 1-2 hours. A full 20-hour production takes roughly 18 hours. You\'ll see progress updates and can step away while it runs.',
  },
  {
    question: 'How do I find the right style and voice?',
    answer: 'Use the individual features — image generation, text-to-video, and text-to-speech — to test different visual style models and voices on short samples. Once you find the combination you like, apply those settings to your full video.',
  },
  {
    question: 'What audio quality should I expect?',
    answer: 'Our TTS produces broadcast-quality narration suitable for monetized channels. Premium voices deliver the best results. For clone voices, test with shorter content first — quality depends on your source audio.',
  },
];

const quickTips = [
  {
    title: 'Write better prompts',
    description: 'Be specific about your concept but flexible on structure. Let the AI handle pacing and chapter breaks.',
  },
  {
    title: 'Match length to your niche',
    description: 'Analyze top performers in your category. North Noir handles 30 minutes to 20 hours — pick what works for your audience.',
  },
  {
    title: 'Test before committing',
    description: 'Try different visual style models, text-to-speech voices, and volume settings on shorter content first. Dial in the look and sound you want before generating a full video.',
  },
];

export default function Help() {
  const { videoId } = useParams();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  useEffect(() => {
    if (videoId) {
      const element = document.getElementById(videoId);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [videoId]);

  return (
    <div className="page-enter" style={{ zoom: 1.1 }}>
      <Helmet>
        <title>Help – North Noir</title>
        <link rel="canonical" href="https://northnoir.com/help" />
      </Helmet>

      {/* Hero */}
      <div className="max-w-7xl mx-auto px-4 pt-section sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <h1 className="text-4xl md:text-5xl font-display font-medium text-white mb-5 tracking-tight">
            Help Center
          </h1>
          <p className="text-lg text-white/60 leading-relaxed">
            Guides, tutorials, and answers to help you produce content effortlessly.
          </p>
        </div>
      </div>

      {/* Quick Tips — horizontal, no cards */}
      <div className="max-w-7xl mx-auto px-4 mt-16 sm:px-6 lg:px-8">
        <div className="grid sm:grid-cols-3 gap-x-12 gap-y-8 border-t border-white/[0.06] pt-10">
          {quickTips.map((tip, i) => (
            <div key={i}>
              <div className="text-xs uppercase tracking-widest text-accent-text mb-3">
                Tip {i + 1}
              </div>
              <h3 className="text-sm font-semibold text-white mb-2">{tip.title}</h3>
              <p className="text-white/50 text-sm leading-relaxed">{tip.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Video Tutorials */}
      {tutorialVideos.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 mt-section sm:px-6 lg:px-8">
          <h2 className="text-2xl font-display font-medium text-white mb-8">
            Video tutorials
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            {tutorialVideos.map((video, index) => (
              <div key={index} id={video.id} className="bg-surface-secondary rounded-lg p-6 border border-white/[0.04]">
                <h3 className="text-base font-semibold text-white mb-2">{video.title}</h3>
                <p className="text-white/50 text-sm mb-5">{video.description}</p>
                <VideoPlayer
                  videoUrl={video.videoUrl}
                  thumbnailUrl={video.thumbnailUrl}
                  thumbnailAlt={video.thumbnailAlt}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FAQ + Support — 2-column layout */}
      <div className="max-w-7xl mx-auto px-4 mt-section sm:px-6 lg:px-8 pb-section">
        <div className="grid lg:grid-cols-[1fr_320px] gap-16">
          {/* FAQ — accordion style */}
          <div>
            <h2 className="text-2xl font-display font-medium text-white mb-8">
              Frequently asked questions
            </h2>
            <div className="divide-y divide-white/[0.06]">
              {faqs.map((faq, index) => {
                const isOpen = openFaq === index;
                return (
                  <div key={index}>
                    <button
                      onClick={() => setOpenFaq(isOpen ? null : index)}
                      className="w-full flex items-center justify-between py-5 text-left group"
                      aria-expanded={isOpen}
                    >
                      <span className="text-sm font-medium text-white group-hover:text-accent-text transition-colors pr-4">
                        {faq.question}
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 text-white/30 flex-shrink-0 transition-transform duration-300 ${
                          isOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    <div
                      className="grid transition-all duration-300 ease-out"
                      style={{
                        gridTemplateRows: isOpen ? '1fr' : '0fr',
                      }}
                    >
                      <div className="overflow-hidden">
                        <div className="pb-5 text-sm text-white/50 leading-relaxed pr-8">
                          {faq.question === 'How do I find profitable long-form niches?' ? (
                            <>
                              For personalized niche guidance, visit{' '}
                              <a
                                href="https://facelessyoutubeempire.com"
                                className="text-accent-text hover:text-white transition-colors"
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                facelessyoutubeempire.com
                              </a>{' '}
                              to schedule a strategy call. They specialize in helping creators discover high-performing niches for long-form content.
                            </>
                          ) : faq.question === 'How do I create my first video?' ? (
                            <>
                              {faq.answer}{' '}
                              <Link to="/" className="text-accent-text hover:text-white transition-colors">
                                View the full guide →
                              </Link>
                            </>
                          ) : (
                            faq.answer
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Support sidebar */}
          <div className="space-y-8">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-white/40 mb-6">
                Support
              </h2>
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-medium text-white mb-1">Technical issues</h3>
                  <p className="text-white/40 text-xs mb-2">Generation, account, or billing problems</p>
                  <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white text-sm transition-colors">
                    contact@northnoir.com
                  </a>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-white mb-1">Feature requests</h3>
                  <p className="text-white/40 text-xs mb-2">Ideas and feedback welcome</p>
                  <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white text-sm transition-colors">
                    contact@northnoir.com
                  </a>
                </div>
              </div>
            </div>

            <div className="border-t border-white/[0.06] pt-6">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="h-3.5 w-3.5 text-white/30" />
                <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Response time</span>
              </div>
              <p className="text-sm text-white/40 leading-relaxed">
                Typically within 24 hours on business days. Include your account email and a description of the issue for faster resolution.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}





