import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { trackConversion, CONVERSION_EVENTS } from '../utils/gtagConversions';

export default function Success() {
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    // Track purchase completion conversion
    trackConversion(CONVERSION_EVENTS.PURCHASE_COMPLETE);

    // Countdown timer
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          navigate('/home');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-surface-primary flex items-center justify-center px-4 relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(220,38,38,0.06)_0%,transparent_60%)]" />
      <div className="max-w-md w-full bg-surface-secondary rounded-lg shadow-xl p-8 text-center border border-border/50 relative dash-animate-in">
        <div className="flex justify-center mb-6">
          <div className="bg-green-500/20 rounded-full p-4">
            <CheckCircle2 className="h-16 w-16 text-green-500" />
          </div>
        </div>
        
        <h1 className="text-3xl font-display tracking-wide text-white mb-4">
          Payment Successful!
        </h1>
        
        <p className="text-text-secondary mb-6">
          Thank you for subscribing to North Noir. Your account has been upgraded and you now have access to all features.
        </p>
        
        <div className="bg-surface-tertiary/50 rounded-lg p-4 mb-6">
          <p className="text-text-muted text-sm mb-2">
            Redirecting to your dashboard in
          </p>
          <p className="text-4xl font-display text-white">
            {countdown}
          </p>
        </div>
        
        <button
          onClick={() => navigate('/home')}
          className="w-full bg-accent hover:bg-accent-hover text-white font-semibold py-3 px-6 rounded-lg transition-colors"
        >
          Go to Dashboard Now
        </button>
      </div>
    </div>
  );
}
