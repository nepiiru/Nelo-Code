export interface CommandAssessment {
  dangerous: boolean;
  reason?: string;
}

interface SafetyRule {
  pattern: RegExp;
  reason: string;
}

const RULES: SafetyRule[] = [
  {
    pattern:
      /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\s+(?:\/|~|\$HOME)(?:\/)?(?:\s|$|\*)/,
    reason: 'Recursive forced delete targeting the filesystem root or the home directory.',
  },
  {
    pattern: /\bmkfs(?:\.[a-zA-Z0-9]+)?\b/,
    reason: 'Formatting a filesystem destroys data.',
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\//,
    reason: 'Writing raw data to a device can destroy the system.',
  },
  {
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/,
    reason: 'Shutting down or rebooting the machine is not allowed.',
  },
  {
    pattern: /:\(\)\s*\{[^}]*:\s*\|\s*:/,
    reason: 'Fork bomb detected.',
  },
  {
    pattern: /\bformat\s+[a-zA-Z]:/,
    reason: 'Formatting a drive destroys data.',
  },
  {
    pattern:
      /\b(?:rm|del)\b[^\n]*(?:\/|\\)(?:etc|bin|boot|dev|proc|sys|usr|var|System32)(?:\/|\\)/,
    reason: 'Deleting system directories is not allowed.',
  },
  {
    pattern: /\bRemove-Item\b[^\n]*-Recurse[^\n]*(?:C:\\|~|\$HOME)/i,
    reason: 'Recursive deletion of system or home paths is not allowed.',
  },
];

export function assessCommand(command: string): CommandAssessment {
  const normalized = command.trim();
  if (!normalized) return { dangerous: false };
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return { dangerous: true, reason: rule.reason };
    }
  }
  return { dangerous: false };
}
