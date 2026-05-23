import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { Loader, Home } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Helmet } from 'react-helmet-async';


const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

export default function SignIn() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: ''
  });
  const [error, setError] = useState<string | null>(null);

  // If user is already signed in, redirect to generator
  useEffect(() => {
    if (!authLoading && user) {
      navigate('/home', { replace: true });
    }
  }, [user, authLoading, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Check provider type
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('provider')
        .eq('email', formData.email)
        .single();

      if (profileError && profileError.code !== 'PGRST116') {
        console.error('Error fetching profile:', profileError);
        throw new Error('Failed to verify account');
      }

      if (profile && profile.provider === 'google') {
        throw new Error('This account was created with Google. Please sign in with Google.');
      }

      // Sign in user with Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: formData.email,
        password: formData.password
      });

      if (authError) {
        console.error('Error signing in:', authError);
        throw new Error(authError.message || 'Invalid email or password');
      }

      if (!authData.user) {
        throw new Error('Sign-in failed: No user data returned');
      }

      // Create or update session
      supabase
        .from('sessions')
        .upsert([
          {
            user_id: authData.user.id,
            session_data: {},
            is_active: true,
            created_at: new Date().toISOString(),
            last_accessed: new Date().toISOString(),
          }
        ])
        .then(({ error: sessionError }) => {
          if (sessionError) {
            console.error('Error creating/updating session:', sessionError);
          }
        });

      // Wait for AuthContext to update user state
      const checkUserState = () => {
        return new Promise<void>((resolve, reject) => {
          const interval = setInterval(() => {
            if (!authLoading) {
              if (user) {
                clearInterval(interval);
                resolve();
              } else {
                clearInterval(interval);
                reject(new Error('User state not updated after sign-in'));
              }
            }
          }, 100);

          // Timeout after 10 seconds
          setTimeout(() => {
            clearInterval(interval);
            reject(new Error('Timeout waiting for user state to update'));
          }, 10000);
        });
      };

      await checkUserState();
      navigate('/home', { replace: true });

      // Clear form data after successful navigation
      setFormData({ email: '', password: '' });
    } catch (err: any) {
      console.error('Sign-in error:', err);
      setError(err.message || 'An unexpected error occurred');
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setGoogleLoading(true);

    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + '/auth/callback',
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });

      if (oauthError) {
        throw new Error(oauthError.message || 'Failed to initiate Google sign-in');
      }
    } catch (err: any) {
      console.error('Google sign-in error:', err);
      setError(err.message || 'An unexpected error occurred');
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-primary flex flex-col justify-center py-12 sm:px-6 lg:px-8 relative">
      {/* Cinematic background treatment */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(220,38,38,0.06)_0%,transparent_60%)]" />

      <Helmet>
        <title>Sign In – North Noir</title>
        <link rel="canonical" href="https://northnoir.com/signin" />
      </Helmet>
      <Link
        to="/"
        className="absolute top-4 left-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-secondary text-text-secondary hover:text-white hover:bg-surface-tertiary transition-colors"
      >
        <Home className="h-5 w-5" />
        <span>Back to Home</span>
      </Link>
      <div className="sm:mx-auto sm:w-full sm:max-w-md relative">
        <div className="flex justify-center mb-4">
          <img
            src="https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/logo.png"
            alt="North Noir"
            className="h-10 w-10"
          />
        </div>
        <h2 className="text-center text-3xl font-display tracking-wide text-white">
          Sign in to your account
        </h2>
        <p className="mt-2 text-center text-sm text-text-secondary">
          Or{' '}
          <Link to="/signup" className="font-medium text-accent-text hover:text-accent transition-colors">
            create a new account
          </Link>
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md relative">
        <div className="bg-surface-secondary py-8 px-4 shadow-xl sm:rounded-lg sm:px-10 border border-white/[0.13]">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-text-secondary">
                Email
              </label>
              <div className="mt-1">
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="appearance-none block w-full px-3 py-2 border border-white/[0.13] rounded-md shadow-sm placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 bg-surface-input text-white/95 sm:text-sm"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-text-secondary">
                Password
              </label>
              <div className="mt-1">
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="appearance-none block w-full px-3 py-2 border border-white/[0.13] rounded-md shadow-sm placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-red-900/60 focus:border-red-800/50 bg-surface-input text-white/95 sm:text-sm"
                />
              </div>
            </div>

            {error && (
              <div className="text-accent-text text-sm">
                {error}
              </div>
            )}

            <div>
              <button
                type="submit"
                disabled={loading || authLoading || googleLoading}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-accent hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <>
                    <Loader className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" />
                    Signing in...
                  </>
                ) : (
                  'Sign in'
                )}
              </button>
            </div>
          </form>

          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-surface-secondary text-text-secondary">Or continue with</span>
              </div>
            </div>

            <div className="mt-6">
              <button
                onClick={handleGoogleSignIn}
                disabled={loading || authLoading || googleLoading}
                className="w-full flex justify-center items-center py-2 px-4 border border-white/[0.13] rounded-md shadow-sm text-sm font-medium text-white bg-surface-tertiary hover:bg-surface-tertiary/80 focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {googleLoading ? (
                  <>
                    <Loader className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" />
                    Signing in with Google...
                  </>
                ) : (
                  <>
                    <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-1.02.68-2.31 1.08-3.71 1.08-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                    Sign in with Google
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

