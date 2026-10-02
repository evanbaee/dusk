import type { SiteMode, Verdict } from './settings';

export type PageState =
  | 'inactive' // Dusk is off right now
  | 'off' // site set to keep original
  | 'pending' // still deciding
  | 'native' // site's own dark theme enabled
  | 'dark' // page was already dark, left alone
  | 'converted'; // Dusk's color conversion applied

export type Message =
  | { type: 'fetch-css'; url: string }
  | { type: 'analyze-image'; url: string }
  | { type: 'verdict'; host: string; verdict: Verdict }
  | { type: 'status' };

export interface StatusReply {
  state: PageState;
  mode: SiteMode;
  host: string | null;
  /** Diagnostics: the scope's current mode and the last error, if any. */
  debug?: { scope: string; error: string | null; support?: string };
}

export interface FetchCssReply {
  text?: string;
  error?: string;
}
