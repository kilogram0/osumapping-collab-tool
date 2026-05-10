import axios from 'axios';
import client from './client';

export interface User {
  id: number;
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
  encrypted_title: string;
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
  encrypted_title: string;
  encrypted_description?: string | null;
  encrypted_song_length_ms: string;
  passphrase_salt: string;
  encrypted_verification: string;
}

export interface UpdateMapsetPayload {
  encrypted_title?: string;
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
