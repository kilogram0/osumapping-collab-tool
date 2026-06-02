import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelMapsetDeletion,
  createMapset,
  createResource,
  deleteMapset,
  deleteResource,
  fetchKickedMapsets,
  fetchMapset,
  fetchMapsets,
  fetchMembers,
  fetchMyMembership,
  fetchStorage,
  fetchResources,
  inviteMember,
  removeMember,
  scheduleMapsetDeletion,
  updateMapset,
  updateMemberRole,
  type CreateMapsetPayload,
  type CreateMapsetResourcePayload,
  type MapsetRole,
  type UpdateMapsetPayload,
} from '../api/endpoints';

export function useStorage() {
  return useQuery({
    queryKey: ['storage'],
    queryFn: fetchStorage,
  });
}

export function useMapsets() {
  return useQuery({
    queryKey: ['mapsets'],
    queryFn: fetchMapsets,
  });
}

export function useKickedMapsets() {
  return useQuery({
    queryKey: ['mapsets-kicked'],
    queryFn: fetchKickedMapsets,
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
      queryClient.invalidateQueries({ queryKey: ['storage'] });
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
      queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

export function useDeleteMapset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMapset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mapsets'] });
      queryClient.invalidateQueries({ queryKey: ['storage'] });
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

export function useMembers(mapsetId: string, enabled = true) {
  return useQuery({
    queryKey: ['members', mapsetId],
    queryFn: () => fetchMembers(mapsetId),
    enabled: !!mapsetId && enabled,
  });
}

export function useInviteMember(mapsetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => inviteMember(mapsetId, username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', mapsetId] });
    },
  });
}

export function useUpdateMemberRole(mapsetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MapsetRole }) =>
      updateMemberRole(mapsetId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', mapsetId] });
      queryClient.invalidateQueries({ queryKey: ['membership', mapsetId] });
      queryClient.invalidateQueries({ queryKey: ['mapsets', mapsetId] });
    },
  });
}

export function useRemoveMember(mapsetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => removeMember(mapsetId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', mapsetId] });
    },
  });
}

export function useScheduleMapsetDeletion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => scheduleMapsetDeletion(id),
    onSuccess: () => {
      // prefix match — also invalidates ['mapsets', id]
      queryClient.invalidateQueries({ queryKey: ['mapsets'] });
      queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

export function useCancelMapsetDeletion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelMapsetDeletion(id),
    onSuccess: () => {
      // prefix match — also invalidates ['mapsets', id]
      queryClient.invalidateQueries({ queryKey: ['mapsets'] });
      queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

export function useResources(mapsetId: string) {
  return useQuery({
    queryKey: ['resources', mapsetId],
    queryFn: () => fetchResources(mapsetId),
    enabled: !!mapsetId,
  });
}

export function useCreateResource(mapsetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateMapsetResourcePayload) => createResource(mapsetId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources', mapsetId] });
      queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}

export function useDeleteResource(mapsetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (resourceId: string) => deleteResource(mapsetId, resourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources', mapsetId] });
      queryClient.invalidateQueries({ queryKey: ['storage'] });
    },
  });
}
