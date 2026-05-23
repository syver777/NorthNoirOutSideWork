import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { Loader } from 'lucide-react';

const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_PUBLISHABLE_KEY
);

export default function AuthCallback() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const handleCallback = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
          console.error('Error getting session:', error);
          navigate('/signin', { state: { error: 'Authentication failed' } });
          return;
        }

        if (data?.session && data.session.user) {
          const user = data.session.user;
          const email = user.email || '';
          const isEmailConfirmation = new URLSearchParams(location.search).get('source') === 'email';

          // Check if profile exists
          const { data: existingProfile, error: profileError } = await supabase
            .from('profiles')
            .select('id, provider')
            .eq('id', user.id)
            .single();

          if (profileError && profileError?.code !== 'PGRST116') {
            console.error('Error checking profile:', profileError);
            navigate('/signin', { state: { error: 'Failed to load profile' } });
            return;
          }

          if (!existingProfile) {
            // Create profile for new user
            const provider = isEmailConfirmation ? 'email' : 'google';
            const { error: profileError } = await supabase
              .from('profiles')
              .insert([
                {
                  id: user.id,
                  email: email,
                  provider: provider,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }
              ]);

            if (profileError) {
              console.error('Error creating profile:', profileError);
              navigate('/signin', { state: { error: 'Failed to create profile' } });
              return;
            }

            // Create user plan
            const { error: planError } = await supabase
              .from('user_plans')
              .insert([
                {
                  id: crypto.randomUUID(),
                  user_id: user.id,
                  plan_type: 'free',
                  tokens_allocated: 400000,
                  tokens_used: 0,
                  rollover_tokens: 0,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  is_active: true,
                  current_period_start: new Date().toISOString(),
                  current_period_end: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString()
                }
              ]);

            if (planError) {
              console.error('Error creating user plan:', planError);
            }

            // Create or update session
            const { error: sessionError } = await supabase
              .from('sessions')
              .upsert([
                {
                  user_id: user.id,
                  session_data: {},
                  is_active: true,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  last_accessed: new Date().toISOString(),
                }
              ]);

            if (sessionError) {
              console.error('Error updating session:', sessionError);
            }
          }

          // Store user ID in localStorage
          localStorage.setItem('userId', user.id);

          // Flag first-time signup so Home can show the welcome modal
          if (!existingProfile) {
            localStorage.setItem('northnoir_show_welcome', 'true');
          }

          // Redirect based on auth type
          navigate('/home', { replace: true });
        } else {
          navigate('/signin', { state: { error: 'No user session found' } });
        }
      } catch (error) {
        console.error('Callback error:', error);
        navigate('/signin', { state: { error: 'Authentication failed' } });
      }
    };

    handleCallback();
  }, [navigate, location.search]);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="text-white text-center">
        <Loader className="animate-spin h-8 w-8 mx-auto" />
        <p className="mt-4">Processing authentication...</p>
      </div>
    </div>
  );
}

