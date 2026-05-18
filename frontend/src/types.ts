import type { Post } from './api/endpoints';

export interface DecryptedPost extends Post {
  decryptedBody: string;
  extractedMs: number | null;
}
