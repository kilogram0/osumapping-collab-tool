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
