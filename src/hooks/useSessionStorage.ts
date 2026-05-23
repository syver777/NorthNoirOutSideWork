import { useState, useEffect } from 'react';

export function useSessionStorage<T>(key: string, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Initialize state from sessionStorage or initialValue
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.sessionStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.warn(`Error reading sessionStorage for key "${key}":`, error);
      return initialValue;
    }
  });

  // Update sessionStorage on state change
  const setValue = (value: React.SetStateAction<T>) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      
      // If the value is null or undefined, remove the item from sessionStorage
      if (valueToStore === null || valueToStore === undefined) {
        window.sessionStorage.removeItem(key);
      } else {
        window.sessionStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch (error) {
      console.warn(`Error setting sessionStorage for key "${key}":`, error);
    }
  };

  return [storedValue, setValue];
}

// Tab-aware session storage hook
export function useTabSessionStorage<T>(key: string, initialValue: T, tab: number): [T, React.Dispatch<React.SetStateAction<T>>] {
  const tabKey = `${key}_tab${tab}`;
  return useSessionStorage(tabKey, initialValue);
}

// Utility function to clear all session storage
export const clearAllSessionStorage = () => {
  try {
    sessionStorage.clear();
    console.log('Session storage cleared');
  } catch (error) {
    console.warn('Error clearing session storage:', error);
  }
};

// Utility function to clear specific session storage keys
export const clearSessionStorageKeys = (keys: string[]) => {
  try {
    keys.forEach(key => {
      sessionStorage.removeItem(key);
    });
    console.log('Specific session storage keys cleared:', keys);
  } catch (error) {
    console.warn('Error clearing specific session storage keys:', error);
  }
};

// Utility function to clear all session storage for a specific tab
export const clearTabSessionStorage = (tab: number) => {
  try {
    const keys = Object.keys(sessionStorage);
    const tabSuffix = `_tab${tab}`;
    keys.forEach(key => {
      if (key.endsWith(tabSuffix)) {
        sessionStorage.removeItem(key);
      }
    });
    console.log(`Session storage cleared for tab ${tab}`);
  } catch (error) {
    console.warn(`Error clearing session storage for tab ${tab}:`, error);
  }
};




