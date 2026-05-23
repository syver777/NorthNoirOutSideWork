import React, { createContext, useContext, useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.SUPABASE_URL as string | undefined;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  // Fail loudly so a missing env var produces a clear message instead of a blank page.
  throw new Error(
    'Missing Supabase env vars: ensure SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set in .env (local) or in the deployment environment (production).'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

interface User {
  id: string;
  email: string;
  full_name?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signOut: async () => {},
  getAccessToken: async () => null,
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check initial user state
    const checkUser = async () => {
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
          console.error('Error getting session:', sessionError);
          setUser(null);
          setLoading(false);
          return;
        }

        if (session?.user) {
          setUser({
            id: session.user.id,
            email: session.user.email ?? '',
          });
          localStorage.setItem('userId', session.user.id);
        } else {
          setUser(null);
          localStorage.removeItem('userId');
        }
      } catch (error) {
        console.error('Unexpected error in checkUser:', error);
        setUser(null);
        localStorage.removeItem('userId');
      } finally {
        setLoading(false);
      }
    };

    checkUser();

    // Listen for auth state changes
    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      try {
        if (event === 'SIGNED_IN' && session?.user) {
          setUser({
            id: session.user.id,
            email: session.user.email ?? '',
          });
          localStorage.setItem('userId', session.user.id);
        } else if (event === 'SIGNED_OUT') {
          setUser(null);
          localStorage.removeItem('userId');
        }
      } catch (error) {
        console.error('Error in onAuthStateChange:', error);
        setUser(null);
        localStorage.removeItem('userId');
      } finally {
        setLoading(false);
      }
    });

    // Cleanup subscription on unmount
    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
      setUser(null);
      localStorage.removeItem('userId');
    } catch (error) {
      console.error('Error signing out:', error);
      setUser(null);
      localStorage.removeItem('userId');
    }
  };

  const getAccessToken = async (): Promise<string | null> => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      return session?.access_token ?? null;
    } catch {
      return null;
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
};
