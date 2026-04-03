import { DARK } from '../context/ThemeContext';

export function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function nextWeekday(date) {
  const d = new Date(date);
  const now = new Date();
  if (d.toDateString() === now.toDateString() && now.getHours() >= 18) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d;
}

export function advanceWeekday(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/** Legacy COLORS export — references dark theme for backward compat */
export const COLORS = DARK;

export function importanceLabelColor(label, colors = DARK) {
  switch (label?.toLowerCase()) {
    case 'critical': return colors.critical;
    case 'high':     return colors.high;
    case 'medium':   return colors.medium;
    default:         return colors.low;
  }
}

export function importanceLabelBg(label, colors = DARK) {
  switch (label?.toLowerCase()) {
    case 'critical': return colors.dangerDim;
    case 'high':     return colors.warningDim;
    case 'medium':   return colors.accentDim;
    default:         return colors.surfaceElevated;
  }
}
