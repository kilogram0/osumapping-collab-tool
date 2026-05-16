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

export interface MapsetMember {
  id: string;
  mapset_id: string;
  user_id: string;
  role: 'owner' | 'mapper' | 'modder';
  created_at: string;
  updated_at: string;
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

export interface Difficulty {
  id: string;
  mapset_id: string;
  encrypted_name: string;
  created_at: string;
  updated_at: string;
}

export async function fetchDifficulties(mapsetId: string): Promise<Difficulty[]> {
  const { data } = await client.get<Difficulty[]>(`/mapsets/${mapsetId}/difficulties`);
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

export interface Section {
  id: string;
  difficulty_id: string;
  encrypted_name: string;
  encrypted_start_time_ms: string;
  encrypted_end_time_ms: string;
  encrypted_sort_order: string;
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

export interface BaseOsuVersion {
  id: string;
  encrypted_content: string;
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
