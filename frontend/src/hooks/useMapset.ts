import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createMapset,
  deleteMapset,
  fetchMapset,
  fetchMapsets,
  fetchMyMembership,
  updateMapset,
  type CreateMapsetPayload,
  type UpdateMapsetPayload,
} from '../api/endpoints';

export function useMapsets() {
  return useQuery({
    queryKey: ['mapsets'],
    queryFn: fetchMapsets,
  });
}

export function useMapset(id: string) {
  return useQuery({
    queryKey: ['mapsets', id],
    queryFn: () => fetchMapset(id),
    enabled: !!id,
  });
}

export function useCreateMapset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMapsetPayload) => createMapset(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mapsets'] });
    },
  });
}

export function useUpdateMapset(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateMapsetPayload) => updateMapset(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mapsets', id] });
      queryClient.invalidateQueries({ queryKey: ['mapsets'] });
    },
  });
}

export function useDeleteMapset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMapset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mapsets'] });
    },
  });
}

export function useMyMembership(mapsetId: string) {
  return useQuery({
    queryKey: ['membership', mapsetId],
    queryFn: () => fetchMyMembership(mapsetId),
    enabled: !!mapsetId,
  });
}
