/** How each versus sub-mode scales a bot's attack, survival and line-clear weights. */
export const MODE_MOD: Record<string, { atk: number; surv: number; clr: number }> = {
  battle: { atk: 1.3, surv: 1, clr: 1 },
  ultra: { atk: 1.45, surv: 0.9, clr: 1 },
  sprint: { atk: 0.95, surv: 0.8, clr: 1.7 },
  endless: { atk: 0.75, surv: 1.5, clr: 0.9 },
  wide: { atk: 1.1, surv: 1.2, clr: 1 },
};
