import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { features } from '../data/features';

export default function Features() {
  // Split features into a highlighted first row (3) and the remaining grid
  const highlighted = features.slice(0, 3);
  const remaining = features.slice(3);

  return (
    <div className="page-enter" style={{ zoom: 1.1 }}>
      <Helmet>
        <title>Features – North Noir</title>
        <link rel="canonical" href="https://northnoir.com/features" />
      </Helmet>

      {/* Hero */}
      <div className="max-w-7xl mx-auto px-4 pt-section sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <h1 className="text-4xl md:text-5xl font-display font-medium text-white mb-5 tracking-tight">
            Everything you need to produce complete videos
          </h1>
          <p className="text-lg text-white/60 leading-relaxed">
            From script to screen — generate full-length YouTube content with AI-driven writing, visuals, and narration in a single workflow.
          </p>
        </div>
      </div>

      {/* Primary features — asymmetric bento layout */}
      <div className="max-w-7xl mx-auto px-4 mt-16 sm:px-6 lg:px-8">
        <div className="grid md:grid-cols-3 gap-px bg-white/[0.04] rounded-xl overflow-hidden">
          {highlighted.map((feature, i) => (
            <div
              key={feature.title}
              className={`bg-surface-secondary p-8 md:p-10 ${i === 0 ? 'md:col-span-2' : i === 2 ? 'md:col-span-3' : ''}`}
            >
              <feature.icon className="h-5 w-5 text-accent-text mb-5" />
              <h2 className="text-xl font-display font-medium text-white mb-3">
                {feature.title}
              </h2>
              <p className="text-white/60 leading-relaxed text-sm">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Remaining features — compact list, no card wrappers */}
      <div className="max-w-7xl mx-auto px-4 mt-section sm:px-6 lg:px-8">
        <h2 className="text-2xl font-display font-medium text-white mb-10">
          The full toolkit
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-10">
          {remaining.map((feature) => (
            <div key={feature.title} className="group">
              <div className="flex items-center gap-3 mb-3">
                <feature.icon className="h-4 w-4 text-accent-text flex-shrink-0" />
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  {feature.title}
                  {feature.comingSoon && (
                    <span className="text-[10px] uppercase tracking-widest text-white/40 bg-white/[0.06] px-2 py-0.5 rounded-full">
                      Soon
                    </span>
                  )}
                </h3>
              </div>
              <p className="text-white/50 text-sm leading-relaxed pl-7">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="max-w-7xl mx-auto px-4 mt-section pb-section sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 border-t border-white/[0.06] pt-10">
          <p className="text-white/40 text-sm">
            Questions about capabilities?
          </p>
          <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white text-sm transition-colors">
            contact@northnoir.com
          </a>
          <Link to="/pricing" className="sm:ml-auto bg-accent text-white px-5 py-2.5 rounded-md hover:bg-accent-hover transition-colors text-sm font-medium">
            View pricing
          </Link>
        </div>
      </div>
    </div>
  );
}


