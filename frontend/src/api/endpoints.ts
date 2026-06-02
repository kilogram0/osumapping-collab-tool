import axios from 'axios';
import client from './client';

export interface User {
  id: string;
  osu_id: number;
  username: string;
  avatar_url: string;
  created_at: string;
  updated_at: string;
}

export async function fetchCurrentUser(): Promise<User | null> {
  try {
    const { data } = await client.get<User>('/auth/me');
    return data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function logout(): Promise<void> {
  await client.post('/auth/logout');
}

export interface Mapset {
  id: string;
  title: string;
  encrypted_description: string | null;
  encrypted_song_length_ms: string;
  passphrase_salt: string;
  encrypted_verification: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  delete_at: string | null;
  difficulty_count: number;
}

export interface StorageInfo {
  used_bytes: number;
  limit_bytes: number;
  pending_bytes: number;
  pending_limit_bytes: number;
}

export async function fetchStorage(): Promise<StorageInfo> {
  const { data } = await client.get<StorageInfo>('/auth/me/storage');
  return data;
}

export interface CreateMapsetPayload {
  id: string;
  title: string;
  encrypted_description?: string | null;
  encrypted_song_length_ms: string;
  passphrase_salt: string;
  encrypted_verification: string;
}

export interface UpdateMapsetPayload {
  title?: string;
  encrypted_description?: string | null;
  encrypted_song_length_ms?: string;
}

export async function fetchMapsets(): Promise<Mapset[]> {
  const { data } = await client.get<Mapset[]>('/mapsets');
  return data;
}

export async function fetchMapset(id: string): Promise<Mapset> {
  const { data } = await client.get<Mapset>(`/mapsets/${id}`);
  return data;
}

export async function createMapset(payload: CreateMapsetPayload): Promise<Mapset> {
  const { data } = await client.post<Mapset>('/mapsets', payload);
  return data;
}

export async function updateMapset(id: string, payload: UpdateMapsetPayload): Promise<Mapset> {
  const { data } = await client.patch<Mapset>(`/mapsets/${id}`, payload);
  return data;
}

export async function deleteMapset(id: string): Promise<void> {
  await client.delete(`/mapsets/${id}`);
}

export async function scheduleMapsetDeletion(id: string): Promise<Mapset> {
  const { data } = await client.post<Mapset>(`/mapsets/${id}/schedule-delete`);
  return data;
}

export async function cancelMapsetDeletion(id: string): Promise<void> {
  await client.delete(`/mapsets/${id}/schedule-delete`);
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export type PostTag = 'general' | 'suggestion' | 'problem' | 'praise' | 'resolve' | 'reopen';

export interface Post {
  id: string;
  difficulty_id: string;
  author_id: string;
  parent_id: string | null;
  tag: PostTag;
  encrypted_body: string;
  created_at: string;
  updated_at: string;
}

export interface DifficultyDetail {
  id: string;
  mapset_id: string;
  encrypted_name: string;
  created_at: string;
  updated_at: string;
  delete_at: string | null;
  sections: Section[];
  posts: Post[];
}

export interface CreatePostPayload {
  id: string;
  tag: PostTag;
  encrypted_body: string;
  parent_id?: string | null;
}

export interface UpdatePostPayload {
  encrypted_body: string;
}

export async function fetchDifficultyDetail(difficultyId: string): Promise<DifficultyDetail> {
  const { data } = await client.get<DifficultyDetail>(`/difficulties/${difficultyId}`);
  return data;
}

export async function createPost(
  difficultyId: string,
  payload: CreatePostPayload,
): Promise<Post> {
  const { data } = await client.post<Post>(`/difficulties/${difficultyId}/posts`, payload);
  return data;
}

export async function updatePost(
  difficultyId: string,
  postId: string,
  payload: UpdatePostPayload,
): Promise<Post> {
  const { data } = await client.put<Post>(`/difficulties/${difficultyId}/posts/${postId}`, payload);
  return data;
}

export async function deletePost(difficultyId: string, postId: string): Promise<void> {
  await client.delete(`/difficulties/${difficultyId}/posts/${postId}`);
}

export type MapsetRole = 'owner' | 'mapper' | 'modder';

export interface MapsetMember {
  id: string;
  mapset_id: string;
  user_id: string;
  role: MapsetRole;
  kicked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KickedMapset extends Mapset {
  kicked_at: string;
  access_expires_at: string;
}

export async function fetchKickedMapsets(): Promise<KickedMapset[]> {
  const { data } = await client.get<KickedMapset[]>('/mapsets/kicked');
  return data;
}

export interface MemberWithUser extends MapsetMember {
  username: string;
  avatar_url: string;
  osu_id: number;
}

export async function fetchMyMembership(mapsetId: string): Promise<MapsetMember | null> {
  try {
    const { data } = await client.get<MapsetMember>(`/mapsets/${mapsetId}/members/me`);
    return data;
  } catch (error) {
    if (axios.isAxiosError(error) && (error.response?.status === 403 || error.response?.status === 404)) {
      return null;
    }
    throw error;
  }
}

export async function fetchMembers(mapsetId: string): Promise<MemberWithUser[]> {
  const { data } = await client.get<MemberWithUser[]>(`/mapsets/${mapsetId}/members`);
  return data;
}

export async function inviteMember(mapsetId: string, username: string): Promise<MemberWithUser> {
  const { data } = await client.post<MemberWithUser>(`/mapsets/${mapsetId}/members`, { username });
  return data;
}

export async function updateMemberRole(
  mapsetId: string,
  userId: string,
  role: MapsetRole,
): Promise<MemberWithUser> {
  const { data } = await client.put<MemberWithUser>(`/mapsets/${mapsetId}/members/${userId}`, { role });
  return data;
}

export async function removeMember(mapsetId: string, userId: string): Promise<void> {
  await client.delete(`/mapsets/${mapsetId}/members/${userId}`);
}

export interface Difficulty {
  id: string;
  mapset_id: string;
  encrypted_name: string;
  created_at: string;
  updated_at: string;
  delete_at: string | null;
}

export async function fetchDifficulties(
  mapsetId: string,
  options?: { includePending?: boolean },
): Promise<Difficulty[]> {
  const url = options?.includePending
    ? `/mapsets/${mapsetId}/difficulties?include_pending=true`
    : `/mapsets/${mapsetId}/difficulties`;
  const { data } = await client.get<Difficulty[]>(url);
  return data;
}

export interface CreateDifficultyPayload {
  id: string;
  encrypted_name: string;
}

export async function createDifficulty(
  mapsetId: string,
  payload: CreateDifficultyPayload,
): Promise<Difficulty> {
  const { data } = await client.post<Difficulty>(`/mapsets/${mapsetId}/difficulties`, payload);
  return data;
}

export interface UpdateDifficultyPayload {
  encrypted_name?: string;
}

export async function updateDifficulty(
  difficultyId: string,
  payload: UpdateDifficultyPayload,
): Promise<Difficulty> {
  const { data } = await client.patch<Difficulty>(`/difficulties/${difficultyId}`, payload);
  return data;
}

export async function deleteDifficulty(difficultyId: string): Promise<Difficulty> {
  const { data } = await client.delete<Difficulty>(`/difficulties/${difficultyId}`);
  return data;
}

export async function restoreDifficulty(difficultyId: string): Promise<Difficulty> {
  const { data } = await client.post<Difficulty>(`/difficulties/${difficultyId}/restore`);
  return data;
}

export interface Section {
  id: string;
  difficulty_id: string;
  encrypted_name: string;
  encrypted_start_time_ms: string;
  encrypted_end_time_ms: string;
  encrypted_sort_order: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export async function fetchSections(difficultyId: string): Promise<Section[]> {
  const { data } = await client.get<Section[]>(`/difficulties/${difficultyId}/sections`);
  return data;
}

export interface CreateSectionPayload {
  id: string;
  encrypted_name: string;
  encrypted_start_time_ms: string;
  encrypted_end_time_ms: string;
  encrypted_sort_order: string;
}

export interface UpdateSectionPayload {
  encrypted_name?: string;
  encrypted_start_time_ms?: string;
  encrypted_end_time_ms?: string;
  encrypted_sort_order?: string;
}

export async function createSection(
  difficultyId: string,
  payload: CreateSectionPayload,
): Promise<Section> {
  const { data } = await client.post<Section>(`/difficulties/${difficultyId}/sections`, payload);
  return data;
}

export async function updateSection(
  difficultyId: string,
  sectionId: string,
  payload: UpdateSectionPayload,
): Promise<Section> {
  const { data } = await client.patch<Section>(`/difficulties/${difficultyId}/sections/${sectionId}`, payload);
  return data;
}

export async function deleteSection(difficultyId: string, sectionId: string): Promise<void> {
  await client.delete(`/difficulties/${difficultyId}/sections/${sectionId}`);
}

export async function assignSection(
  difficultyId: string,
  sectionId: string,
  userId: string | null,
): Promise<Section> {
  const { data } = await client.patch<Section>(
    `/difficulties/${difficultyId}/sections/${sectionId}/assign`,
    { user_id: userId },
  );
  return data;
}

export interface SectionOsuVersion {
  id: string;
  section_id: string;
  encrypted_content: string;
  version: number;
  is_active: boolean;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
}

/** Shape of `GET /api/difficulties/{id}/base.osu` — matches BaseOsuRead in
 *  backend/app/schemas.py. All fields are always present per that contract.
 *  Consumers that previously fell back with `?? null` did so defensively
 *  against older mocks, not the live API. */
export interface BaseOsuVersion {
  id: string;
  encrypted_content: string;
  version: number;
  difficulty_id: string;
  is_active: boolean;
  source_section_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadSectionOsuPayload {
  id: string;
  encrypted_content: string;
  base_version?: {
    id: string;
    encrypted_content: string;
  } | null;
}

export async function uploadSectionOsu(
  difficultyId: string,
  sectionId: string,
  payload: UploadSectionOsuPayload,
): Promise<SectionOsuVersion> {
  const { data } = await client.post<SectionOsuVersion>(
    `/difficulties/${difficultyId}/sections/${sectionId}/osu`,
    payload,
  );
  return data;
}

export async function downloadSectionOsu(
  difficultyId: string,
  sectionId: string,
): Promise<SectionOsuVersion> {
  const { data } = await client.get<SectionOsuVersion>(
    `/difficulties/${difficultyId}/sections/${sectionId}/osu`,
  );
  return data;
}

export async function downloadBaseOsu(difficultyId: string): Promise<BaseOsuVersion> {
  const { data } = await client.get<BaseOsuVersion>(`/difficulties/${difficultyId}/base.osu`);
  return data;
}

export interface CreateBaseOsuVersionPayload {
  id: string;
  encrypted_content: string;
}

/** Mint a new active base version directly (not bundled with a section upload).
 *  Owner-only server-side. Used to keep the base's bookmarks in sync with the
 *  section divisions after a structural edit. */
export async function createBaseOsuVersion(
  difficultyId: string,
  payload: CreateBaseOsuVersionPayload,
): Promise<BaseOsuVersion> {
  const { data } = await client.post<BaseOsuVersion>(
    `/difficulties/${difficultyId}/base/versions`,
    payload,
  );
  return data;
}

export interface SectionOsuVersionListItem {
  id: string;
  version: number;
  is_active: boolean;
  uploaded_by: string;
  created_at: string;
}

export interface BaseOsuVersionListItem {
  id: string;
  version: number;
  is_active: boolean;
  source_section_version_id: string | null;
  created_at: string;
}

export async function fetchSectionOsuVersions(
  difficultyId: string,
  sectionId: string,
): Promise<SectionOsuVersionListItem[]> {
  const { data } = await client.get<SectionOsuVersionListItem[]>(
    `/difficulties/${difficultyId}/sections/${sectionId}/osu/versions`,
  );
  return data;
}

export async function activateSectionOsuVersion(
  difficultyId: string,
  sectionId: string,
  versionId: string,
): Promise<SectionOsuVersion> {
  const { data } = await client.post<SectionOsuVersion>(
    `/difficulties/${difficultyId}/sections/${sectionId}/osu/versions/${versionId}/activate`,
    {},
  );
  return data;
}

export async function fetchBaseOsuVersions(difficultyId: string): Promise<BaseOsuVersionListItem[]> {
  const { data } = await client.get<BaseOsuVersionListItem[]>(`/difficulties/${difficultyId}/base/versions`);
  return data;
}

export async function activateBaseOsuVersion(
  difficultyId: string,
  versionId: string,
): Promise<BaseOsuVersion> {
  const { data } = await client.post<BaseOsuVersion>(
    `/difficulties/${difficultyId}/base/versions/${versionId}/activate`,
    {},
  );
  return data;
}

// ---------------------------------------------------------------------------
// Difficulty pins (named snapshots of the fully-assembled .osu)
// ---------------------------------------------------------------------------

/** Pin metadata — matches DifficultyPinRead. No content blob. */
export interface DifficultyPin {
  id: string;
  difficulty_id: string;
  encrypted_label: string;
  created_by: string;
  created_at: string;
}

/** A pin including its assembled .osu ciphertext — matches DifficultyPinContentRead. */
export interface DifficultyPinContent extends DifficultyPin {
  encrypted_content: string;
}

export interface CreateDifficultyPinPayload {
  id: string;
  encrypted_label: string;
  encrypted_content: string;
}

export async function createPin(
  difficultyId: string,
  payload: CreateDifficultyPinPayload,
): Promise<DifficultyPin> {
  const { data } = await client.post<DifficultyPin>(
    `/difficulties/${difficultyId}/pins`,
    payload,
  );
  return data;
}

export async function fetchPins(difficultyId: string): Promise<DifficultyPin[]> {
  const { data } = await client.get<DifficultyPin[]>(`/difficulties/${difficultyId}/pins`);
  return data;
}

export async function fetchPin(
  difficultyId: string,
  pinId: string,
): Promise<DifficultyPinContent> {
  const { data } = await client.get<DifficultyPinContent>(
    `/difficulties/${difficultyId}/pins/${pinId}`,
  );
  return data;
}

export async function deletePin(difficultyId: string, pinId: string): Promise<void> {
  await client.delete(`/difficulties/${difficultyId}/pins/${pinId}`);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface MapsetResource {
  id: string;
  mapset_id: string;
  encrypted_name: string;
  encrypted_url: string;
  /** Encrypted icon key (from the client-side pool). Null on legacy rows. */
  encrypted_icon: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateMapsetResourcePayload {
  id: string;
  encrypted_name: string;
  encrypted_url: string;
  encrypted_icon?: string;
  position?: number;
}

export async function fetchResources(mapsetId: string): Promise<MapsetResource[]> {
  const { data } = await client.get<MapsetResource[]>(`/mapsets/${mapsetId}/resources`);
  return data;
}

export async function createResource(
  mapsetId: string,
  payload: CreateMapsetResourcePayload,
): Promise<MapsetResource> {
  const { data } = await client.post<MapsetResource>(`/mapsets/${mapsetId}/resources`, payload);
  return data;
}

export async function deleteResource(mapsetId: string, resourceId: string): Promise<void> {
  await client.delete(`/mapsets/${mapsetId}/resources/${resourceId}`);
}
