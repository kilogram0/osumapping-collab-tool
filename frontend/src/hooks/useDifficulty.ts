import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateBaseOsuVersion,
  activateSectionOsuVersion,
  createDifficulty,
  createPost,
  createSection,
  deletePost,
  fetchBaseOsuVersions,
  fetchDifficulties,
  fetchDifficultyDetail,
  fetchSectionOsuVersions,
  updatePost,
  updateSection,
} from '../api/endpoints';

export function useDifficulties(mapsetId: string) {
  return useQuery({
    queryKey: ['difficulties', mapsetId],
    queryFn: () => fetchDifficulties(mapsetId),
    enabled: !!mapsetId,
  });
}

export function useCreateDifficulty(mapsetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Parameters<typeof createDifficulty>[1]) =>
      createDifficulty(mapsetId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['difficulties', mapsetId] });
    },
  });
}

export function useCreateSection(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Parameters<typeof createSection>[1]) =>
      createSection(difficultyId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });
    },
  });
}

export function useUpdateSection(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sectionId,
      payload,
    }: {
      sectionId: string;
      payload: Parameters<typeof updateSection>[2];
    }) => updateSection(difficultyId, sectionId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });
    },
  });
}

export function useSectionOsuVersions(difficultyId: string, sectionId: string | null) {
  return useQuery({
    queryKey: ['section-osu-versions', difficultyId, sectionId],
    queryFn: () => fetchSectionOsuVersions(difficultyId, sectionId!),
    enabled: !!difficultyId && !!sectionId,
  });
}

export function useActivateSectionOsuVersion(difficultyId: string, sectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => activateSectionOsuVersion(difficultyId, sectionId, versionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['section-osu-versions', difficultyId, sectionId] });
      queryClient.invalidateQueries({ queryKey: ['sections', difficultyId] });
    },
  });
}

export function useBaseOsuVersions(difficultyId: string) {
  return useQuery({
    queryKey: ['base-osu-versions', difficultyId],
    queryFn: () => fetchBaseOsuVersions(difficultyId),
    enabled: !!difficultyId,
  });
}

export function useActivateBaseOsuVersion(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => activateBaseOsuVersion(difficultyId, versionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['base-osu-versions', difficultyId] });
      queryClient.invalidateQueries({ queryKey: ['difficulties', difficultyId] });
    },
  });
}

export function useDifficultyDetail(difficultyId: string | null) {
  return useQuery({
    queryKey: ['difficulty-detail', difficultyId],
    queryFn: () => fetchDifficultyDetail(difficultyId!),
    enabled: !!difficultyId,
  });
}

export function useCreatePost(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Parameters<typeof createPost>[1]) => createPost(difficultyId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });
    },
  });
}

export function useUpdatePost(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, payload }: { postId: string; payload: Parameters<typeof updatePost>[2] }) =>
      updatePost(difficultyId, postId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });
    },
  });
}

export function useDeletePost(difficultyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) => deletePost(difficultyId, postId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['difficulty-detail', difficultyId] });
    },
  });
}
