import type { NormalizedPost, SourceName } from '../types.js';

export interface SourceHealth {
  source: SourceName;
  connected: boolean;
  lastEventAt?: string;
  lastSuccessAt?: string;
  error?: string | null;
}

export interface SourceAdapter {
  readonly source: SourceName;
  start(onPost: (post: NormalizedPost, cursor?: string, recovered?: boolean) => Promise<void>, onHealth: (health: Partial<SourceHealth>) => void): Promise<void>;
  stop(): void;
}
