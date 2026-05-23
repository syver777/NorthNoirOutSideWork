import React from 'react';
import { Helmet } from 'react-helmet-async';

export default function Privacy() {
  return (
    <div className="page-enter max-w-3xl mx-auto px-4 pt-section pb-section sm:px-6 lg:px-8">
      <Helmet>
        <title>Privacy Policy – North Noir</title>
        <link rel="canonical" href="https://northnoir.com/privacy" />
      </Helmet>

      <div className="prose prose-invert">
        <h1 className="text-3xl md:text-4xl font-display font-medium text-white mb-2 tracking-tight">Privacy Policy</h1>

        <p className="text-white/40 text-sm mb-12">Last updated: March 2026</p>
        
        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">1. Introduction</h2>
          <p className="text-white/60">
            At North Noir, we take your privacy seriously. This policy explains how we collect, use, and protect your personal information
            when you use our AI-powered long-form content generation platform.
          </p>
          <p className="text-white/60 mt-4">
            <strong>Data Controller:</strong> North Noir operates as the data controller for personal data collected through this platform.
            For all privacy-related matters, contact us at{' '}
            <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white transition-colors">contact@northnoir.com</a>.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">2. Information We Collect</h2>
          <div className="space-y-4 text-white/60">
            <p><strong>We collect the following types of information:</strong></p>
            <ul className="list-disc pl-6">
              <li>Story inputs (titles, descriptions, and preferences)</li>
              <li>Generated content (stories, scripts, and narratives)</li>
              <li>Usage data to improve our AI models</li>
              <li>Technical information about your device and connection</li>
            </ul>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">2.1. Voice Data Collection</h2>
          <div className="space-y-4 text-white/60">
            <p><strong>When you use our voice cloning services, we collect:</strong></p>
            <ul className="list-disc pl-6">
              <li>Audio files you upload for voice cloning purposes</li>
              <li>Voice characteristics and patterns extracted from your audio samples</li>
              <li>Metadata associated with voice recordings (duration, format, quality)</li>
              <li>Voice generation preferences and settings</li>
            </ul>
            <p className="mt-4">
              <strong>Voice Data Security:</strong> Voice samples and cloned voice models are encrypted and stored securely.
              We implement additional security measures for voice data due to its sensitive biometric nature.
            </p>
            <p>
              <strong>Voice Data Retention:</strong> Voice cloning data is retained only as long as necessary to provide
              the service. You may request deletion of your voice data at any time, though this will disable voice cloning
              functionality for your account.
            </p>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">2.2. AI Processing and Data Usage</h2>
          <div className="space-y-4 text-white/60">
            <p><strong>Artificial Intelligence Data Processing:</strong></p>
            <p>
              We use artificial intelligence technologies to generate text, images, and audio content based on your inputs.
              When you use our AI services, we collect and process:
            </p>
            <ul className="list-disc pl-6 mt-4">
              <li>Text prompts, story titles, descriptions, and creative preferences you provide</li>
              <li>Image generation requests, style preferences, and visual specifications</li>
              <li>Audio generation inputs, voice selections, and synthesis parameters</li>
              <li>User interaction data with AI-generated content (ratings, edits, regeneration requests)</li>
              <li>Technical parameters and settings for content generation</li>
            </ul>
            
            <p className="mt-4">
              <strong>Third-Party AI Services:</strong> Your inputs are processed through various third-party AI service providers
              to generate the requested content. These services process your data temporarily to fulfill generation requests but
              do not use your data to train their general AI models unless explicitly stated otherwise.
            </p>
            
            <p className="mt-4">
              <strong>Data Usage for Generation Only:</strong> User inputs provided to AI systems are used solely for the purpose
              of generating the requested content (text, images, or audio) and are not used to train or improve general AI models
              without your explicit consent.
            </p>
            
            <p className="mt-4">
              <strong>Automated Decision-Making:</strong> Our AI systems make automated decisions about content generation,
              including style, tone, visual elements, and audio characteristics based on your inputs. These automated processes
              may significantly affect the content you receive. You have the right to:
            </p>
            <ul className="list-disc pl-6 mt-2">
              <li>Request information about the logic involved in automated decision-making</li>
              <li>Request human intervention or review of automated decisions</li>
              <li>Challenge or contest automated decisions that affect your content</li>
              <li>Receive explanations about how automated systems process your data</li>
            </ul>
            
            <p className="mt-4">
              <strong>Data Retention During Processing:</strong> Input data is retained temporarily during the generation process
              and for a limited time afterward to ensure service quality and handle any regeneration requests. This data is
              automatically deleted according to our retention schedule unless you request earlier deletion.
            </p>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">3. How We Use Your Information</h2>
          <div className="space-y-4 text-white/60">
            <p>Your information is used to:</p>
            <ul className="list-disc pl-6">
              <li>Generate and deliver your requested content</li>
              <li>Improve our AI models and story generation quality</li>
              <li>Provide technical support</li>
              <li>Send important service updates</li>
            </ul>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">4. Data Protection</h2>
          <p className="text-white/60">
            We implement strong security measures to protect your data:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li>Encryption of data in transit and at rest</li>
            <li>Regular security audits and updates</li>
            <li>Strict access controls for our team</li>
            <li>Regular backups to prevent data loss</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">5. Legal Basis for Processing (GDPR)</h2>
          <p className="text-white/60">
            For users in the European Union and European Economic Area, we process your personal data on the following legal bases under the <strong>General Data Protection Regulation (GDPR) (Regulation (EU) 2016/679)</strong>:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li><strong>Performance of a contract (Art. 6(1)(b) GDPR):</strong> Processing necessary to provide our services, including generating content, managing your account, and processing payments.</li>
            <li><strong>Legitimate interests (Art. 6(1)(f) GDPR):</strong> Processing for security, fraud prevention, service improvement, and analytics, where our interests do not override your fundamental rights.</li>
            <li><strong>Consent (Art. 6(1)(a) GDPR):</strong> Where you have given explicit consent, such as for optional marketing communications or non-essential analytics.</li>
            <li><strong>Legal obligation (Art. 6(1)(c) GDPR):</strong> Where processing is necessary to comply with a legal obligation, such as financial record-keeping.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">5.1. Your Rights</h2>
          <p className="text-white/60">
            You have the right to:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li><strong>Access (Art. 15 GDPR):</strong> Request a copy of your personal data</li>
            <li><strong>Rectification (Art. 16 GDPR):</strong> Request correction of inaccurate data</li>
            <li><strong>Erasure (Art. 17 GDPR):</strong> Request deletion of your personal data (&ldquo;right to be forgotten&rdquo;)</li>
            <li><strong>Restriction (Art. 18 GDPR):</strong> Request restriction of processing in certain circumstances</li>
            <li><strong>Data portability (Art. 20 GDPR):</strong> Receive your data in a structured, machine-readable format</li>
            <li><strong>Objection (Art. 21 GDPR):</strong> Object to processing based on legitimate interests</li>
            <li><strong>Withdraw consent:</strong> Withdraw previously given consent at any time</li>
            <li><strong>Lodge a complaint:</strong> Lodge a complaint with your local data protection authority</li>
            <li>Export your generated content at any time</li>
          </ul>
          <p className="text-white/60 mt-4">
            To exercise any of these rights, contact us at{' '}
            <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white transition-colors">contact@northnoir.com</a>.
            We will respond within 30 days.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">5.2. International Data Transfers</h2>
          <p className="text-white/60">
            Your data may be processed by our service providers in countries outside the European Economic Area (EEA) or United Kingdom (UK), including in the United States. When we transfer personal data internationally, we ensure appropriate safeguards are in place, such as:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li>Standard Contractual Clauses (SCCs) approved by the European Commission</li>
            <li>Transfers to countries with an EU adequacy decision</li>
            <li>Other legally recognised transfer mechanisms under Chapter V of the GDPR</li>
          </ul>
          <p className="text-white/60 mt-4">
            Our primary infrastructure provider (Supabase) operates under standard contractual clauses. AI generation services are processed by third-party providers who maintain appropriate data processing agreements.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">6. Data Retention</h2>
          <p className="text-white/60">
            We retain your data only as long as necessary to provide our services and comply with legal obligations.
            You can request deletion of your data at any time. In general:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li>Account data is retained for the duration of your subscription and up to 90 days after account closure</li>
            <li>Generated content is retained for the duration of your subscription and deleted within 90 days of account closure, unless you request earlier deletion</li>
            <li>Voice cloning data is deleted upon request or within 30 days of account closure</li>
            <li>Financial records may be retained for up to 7 years to comply with tax and accounting obligations</li>
            <li>Server and security logs are retained for up to 12 months</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">6.1. Cookies and Tracking Technologies</h2>
          <p className="text-white/60">
            We use essential cookies and similar technologies necessary for the operation of our platform (e.g., authentication sessions). We do not use third-party advertising or tracking cookies without your consent. By using our platform, you consent to the use of strictly necessary cookies. You may manage cookie preferences through your browser settings.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">7. EU AI Act &amp; Automated Processing Transparency</h2>
          <p className="text-white/60">
            In accordance with the <strong>EU Artificial Intelligence Act (Regulation (EU) 2024/1689)</strong> and the GDPR&rsquo;s requirements on automated decision-making (Art. 22 GDPR), we disclose the following:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li>All content generated on our platform is produced by AI systems. We clearly label all AI-generated outputs.</li>
            <li>Our AI systems do not make decisions with legal or similarly significant effects on you — they generate creative content based on your inputs.</li>
            <li>You are always in control: you can accept, reject, edit, or regenerate any AI output.</li>
            <li>Our AI models are not used for prohibited purposes under the EU AI Act (e.g., social scoring, biometric surveillance, or subliminal manipulation).</li>
            <li>We are committed to maintaining human oversight of AI systems and updating our practices as the EU AI Act&rsquo;s implementation milestones take effect.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">7.1. GPSR and Software Safety</h2>
          <p className="text-white/60">
            The <strong>EU General Product Safety Regulation (GPSR) (Regulation (EU) 2023/988)</strong> applies from 13 December 2024 and covers products including software and digital products. North Noir is operated as an online digital service. To the extent any software component of our platform is treated as a product under GPSR:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li>We commit to offering software that is safe for its intended use</li>
            <li>We process no personal data for purposes that would pose safety risks to consumers</li>
            <li>We maintain procedures to address product safety concerns and promptly remediate identified issues</li>
            <li>Safety-related concerns about our software can be reported to <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white transition-colors">contact@northnoir.com</a></li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">8. California Privacy Rights (CCPA/CPRA)</h2>
          <p className="text-white/60">
            If you are a California resident, the <strong>California Consumer Privacy Act (CCPA)</strong> and <strong>California Privacy Rights Act (CPRA)</strong> grant you additional rights:
          </p>
          <ul className="list-disc pl-6 mt-4 text-white/60">
            <li><strong>Right to Know:</strong> Request disclosure of the categories and specific pieces of personal information we collect about you</li>
            <li><strong>Right to Delete:</strong> Request deletion of your personal information, subject to certain exceptions</li>
            <li><strong>Right to Correct:</strong> Request correction of inaccurate personal information</li>
            <li><strong>Right to Opt-Out:</strong> We do not sell or share personal information for cross-context behavioural advertising</li>
            <li><strong>Right to Non-Discrimination:</strong> We will not discriminate against you for exercising your CCPA rights</li>
          </ul>
          <p className="text-white/60 mt-4">
            To exercise California privacy rights, contact us at{' '}
            <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white transition-colors">contact@northnoir.com</a>.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">9. Updates to Privacy Policy</h2>
          <p className="text-white/60">
            We may update this policy periodically. We will notify you of significant changes via email or through our platform. Continued use of our services after updates constitutes acceptance of the revised policy.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-display font-medium text-white mb-4">10. Contact Information &amp; Supervisory Authority</h2>
          <p className="text-white/60">
            For privacy-related questions or concerns, contact us at{' '}
            <a href="mailto:contact@northnoir.com" className="text-accent-text hover:text-white transition-colors">
              contact@northnoir.com
            </a>
          </p>
          <p className="text-white/60 mt-4">
            If you are in the EU/EEA and believe we have not addressed your privacy concern adequately, you have the right to lodge a complaint with your local data protection supervisory authority. A list of EU data protection authorities is available at{' '}
            <a href="https://edpb.europa.eu/about-edpb/about-edpb/members_en" className="text-accent-text hover:text-white transition-colors" target="_blank" rel="noopener noreferrer">edpb.europa.eu</a>.
          </p>
        </section>
      </div>
    </div>
  );
}


