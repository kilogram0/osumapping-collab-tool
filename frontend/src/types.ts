import type { Post } from './api/endpoints';

export interface DecryptedSection {
  id: string;
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  sortOrder: number;
  assignedTo: string | null;
}

export interface DecryptedPost extends Post {
  decryptedBody: string;
  extractedMs: number | null;
}
