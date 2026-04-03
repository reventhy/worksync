import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Notion-inspired Palette ───────────────────────────────────────────────────

export const DARK = {
  bg:              '#191919',
  surface:         '#202020',
  surfaceElevated: '#2b2b2b',
  border:          'rgba(255,255,255,0.082)',
  border2:         'rgba(255,255,255,0.14)',
  accent:          '#2383e2',
  accentDim:       'rgba(35,131,226,0.1)',
  text:            '#e8e8e8',
  subtext:         '#9b9b9b',
  muted:           '#6b6b6b',
  success:         '#4dac6d',
  successDim:      'rgba(77,172,109,0.08)',
  danger:          '#eb5757',
  dangerDim:       'rgba(235,87,87,0.08)',
  warning:         '#dfab01',
  warningDim:      'rgba(223,171,1,0.08)',
  orange:          '#d9730d',
  critical:        '#eb5757',
  high:            '#d9730d',
  medium:          '#2383e2',
  low:             '#9b9b9b',
  jira:            '#2d7cfc',
  tabBar:          '#191919',
  tabActive:       '#2383e2',
  tabInactive:     '#6b6b6b',
  statusBar:       'light',
};

export const LIGHT = {
  bg:              '#ffffff',
  surface:         '#f7f7f5',
  surfaceElevated: '#efefed',
  border:          'rgba(55,53,47,0.09)',
  border2:         'rgba(55,53,47,0.18)',
  accent:          '#2383e2',
  accentDim:       'rgba(35,131,226,0.08)',
  text:            '#37352f',
  subtext:         '#787774',
  muted:           '#9b9b97',
  success:         '#0f7b6c',
  successDim:      'rgba(15,123,108,0.08)',
  danger:          '#e03e3e',
  dangerDim:       'rgba(224,62,62,0.08)',
  warning:         '#c9890c',
  warningDim:      'rgba(201,137,12,0.08)',
  orange:          '#c4621e',
  critical:        '#e03e3e',
  high:            '#c4621e',
  medium:          '#2383e2',
  low:             '#9b9b97',
  jira:            '#1868db',
  tabBar:          '#f7f7f5',
  tabActive:       '#2383e2',
  tabInactive:     '#9b9b97',
  statusBar:       'dark',
};

// ── Context ───────────────────────────────────────────────────────────────────

const ThemeContext = createContext({ colors: DARK, isDark: true, toggleTheme: () => {} });

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem('wsTheme').then(val => {
      if (val === 'light') setIsDark(false);
    }).catch(() => {});
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      AsyncStorage.setItem('wsTheme', next ? 'dark' : 'light').catch(() => {});
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ colors: isDark ? DARK : LIGHT, isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
