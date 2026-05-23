import { useState, useEffect } from 'react';

/**
 * Tab-aware session storage hook
 * Namespaces session storage keys by tab number to ensure complete isolation between tabs
 * Pattern: tab{N}_{key}
 * This works for any page type (video, audio, image, etc.)
 */
export function useTabSessionStorage<T>(
  key: string,
  defaultValue: T,
  tab: number
): [T, (value: T | ((val: T) => T)) => void] {
  const tabKey = `tab${tab}_${key}`;
  
  const [state, setState] = useState<T>(() => {
    try {
      const item = window.sessionStorage.getItem(tabKey);
      return item ? JSON.parse(item) : defaultValue;
    } catch (error) {
      console.warn(`Error loading session storage for ${tabKey}:`, error);
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(tabKey, JSON.stringify(state));
    } catch (error) {
      console.error(`Error saving to session storage for ${tabKey}:`, error);
    }
  }, [tabKey, state]);

  return [state, setState];
}
