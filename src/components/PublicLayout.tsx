import React, { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const XLogo = () => (
  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const DiscordLogo = () => (
  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
  </svg>
);

interface PublicLayoutProps {
  isMenuOpen: boolean;
  setIsMenuOpen: (value: boolean) => void;
}

export default function PublicLayout({ isMenuOpen, setIsMenuOpen }: PublicLayoutProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Scroll to top on route change (but preserve hash-based navigation)
  useEffect(() => {
    if (!location.hash) {
      window.scrollTo(0, 0);
    }
  }, [location.pathname, location.hash]);

  // If still loading, show a minimal spinner
  if (loading) {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-accent"></div>
      </div>
    );
  }

  // Determine button text and destination based on auth state
  const authButtonText = user ? 'Dashboard' : 'Sign Up';
  const authButtonDestination = user ? '/home' : '/signup';

  return (
    <div className="min-h-screen bg-surface-primary text-white">
      <a href="#main-content" className="sr-skip-link">Skip to main content</a>

      {/* Navigation */}
      <nav className="bg-black/30 backdrop-blur-xl border-b border-white/5 animate-[navSlideDown_0.8s_cubic-bezier(0.16,1,0.3,1)_both]" aria-label="Main navigation">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex-shrink-0">
              <Link to="/" className="flex items-center space-x-2">
                <img 
                  src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/logo.png"
                  alt="North Noir Logo"
                  className="h-8 w-8"
                  width={32}
                  height={32}
                />
                <span className="text-xl font-bold font-display tracking-wide">North Noir</span>
              </Link>
            </div>

            {/* Desktop Navigation */}
            <div className="hidden md:flex md:flex-1 md:justify-center">
              <div className="flex items-center space-x-8">
                <Link to="/features" className="text-white/70 hover:text-accent-text transition-colors">Features</Link>
                <Link to="/pricing" className="text-white/70 hover:text-accent-text transition-colors">Pricing</Link>
                <Link to="/about" className="text-white/70 hover:text-accent-text transition-colors">About</Link>
                <Link to="/help" className="text-white/70 hover:text-accent-text transition-colors">Help</Link>
              </div>
            </div>

            {/* Auth Button */}
            <div className="hidden md:flex items-center">
              <Link to={authButtonDestination} className="bg-accent text-white px-4 py-2 rounded-md hover:bg-accent-hover transition-colors">
                {authButtonText}
              </Link>
            </div>

            {/* Mobile menu button */}
            <div className="md:hidden">
              <button
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="text-white/70 hover:text-white p-2 rounded-md"
                aria-expanded={isMenuOpen}
                aria-label="Toggle navigation menu"
              >
                {isMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Navigation */}
        {isMenuOpen && (
          <div className="md:hidden">
            <div className="px-2 pt-2 pb-3 space-y-1 sm:px-3">
              <Link to="/features" onClick={() => setIsMenuOpen(false)} className="block px-3 py-2 text-white/70 hover:text-accent-text transition-colors">Features</Link>
              <Link to="/pricing" onClick={() => setIsMenuOpen(false)} className="block px-3 py-2 text-white/70 hover:text-accent-text transition-colors">Pricing</Link>
              <Link to="/about" onClick={() => setIsMenuOpen(false)} className="block px-3 py-2 text-white/70 hover:text-accent-text transition-colors">About</Link>
              <Link to="/help" onClick={() => setIsMenuOpen(false)} className="block px-3 py-2 text-white/70 hover:text-accent-text transition-colors">Help</Link>
              <div className="border-t border-white/10 my-2"></div>
              <Link to={authButtonDestination} onClick={() => setIsMenuOpen(false)} className="block px-3 py-2 bg-accent text-white rounded-md hover:bg-accent-hover transition-colors">
                {authButtonText}
              </Link>
            </div>
          </div>
        )}
      </nav>

      {/* Main Content */}
      <main id="main-content">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="bg-black/30 backdrop-blur-xl border-t border-white/5">
        <div className="max-w-7xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider">Product</h2>
              <div className="mt-4 space-y-4">
                <Link to="/features" className="block text-white/70 hover:text-accent-text">Features</Link>
                <Link to="/pricing" className="block text-white/70 hover:text-accent-text">Pricing</Link>
              </div>
            </div>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider">Support</h2>
              <div className="mt-4 space-y-4">
                <Link to="/help" className="block text-white/70 hover:text-accent-text">Help Center</Link>
                <Link to="/about" className="block text-white/70 hover:text-accent-text">About Us</Link>
              </div>
            </div>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider">Legal</h2>
              <div className="mt-4 space-y-4">
                <Link to="/privacy" className="block text-white/70 hover:text-accent-text">Privacy Policy</Link>
                <Link to="/terms" className="block text-white/70 hover:text-accent-text">Terms of Service</Link>
              </div>
            </div>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider">Social</h2>
              <div className="mt-4 flex items-center space-x-4">
                <a 
                  href="https://x.com/NorthNoirAI" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="inline-block text-white/40 hover:text-white transition-colors"
                >
                  <XLogo />
                  <span className="sr-only">X (Twitter)</span>
                </a>
                <a
                  href="https://discord.gg/ZRJ7zMT56"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-white/40 hover:text-white transition-colors"
                >
                  <DiscordLogo />
                  <span className="sr-only">Discord</span>
                </a>
              </div>
            </div>
          </div>
          <div className="mt-8 border-t border-white/10 pt-8 md:flex md:items-center md:justify-between">
            <div className="flex space-x-6 md:order-2">
              <Link to="/" className="text-white/40 hover:text-accent-text">
                <img 
                  src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/logo.png"
                  alt="North Noir Logo"
                  className="h-6 w-6"
                  width={24}
                  height={24}
                  loading="lazy"
                  decoding="async"
                />
              </Link>
            </div>
            <p className="mt-8 text-base text-white/40 md:mt-0 md:order-1">
              © {new Date().getFullYear()} North Noir. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}




